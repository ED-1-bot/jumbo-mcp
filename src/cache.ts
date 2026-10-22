import { createHash } from "node:crypto";

/**
 * In-process TTL cache for upstream Albert Heijn responses.
 *
 * Scope: the lifetime of one MCP server process. Nothing is written to disk —
 * the cache never persists credentials, receipts or member data.
 *
 * Keys are human-readable prefixes (`GET /mobile-services/... <digest>`) so a
 * write can invalidate a whole namespace with `invalidate(prefix)`.
 */

export interface CacheStats {
  enabled: boolean;
  maxEntries: number;
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  entries: number;
  hitRate: number;
}

export interface TtlCacheOptions {
  /**
   * Static flag, or a predicate evaluated per operation. A predicate keeps
   * `JUMBO_MCP_CACHE=off` authoritative for every cache in the process, even
   * one constructed before the variable changed.
   */
  enabled?: boolean | (() => boolean);
  maxEntries?: number;
  now?: () => number;
}

/** JSON with object keys sorted recursively, so equal inputs hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Build a cache key: readable namespace prefix + digest of the parameters. */
export function cacheKey(prefix: string, parts: unknown[]): string {
  const digest = createHash("sha1").update(stableStringify(parts)).digest("hex");
  return `${prefix} ${digest}`;
}

/**
 * Merge several cache snapshots into the single report a stats surface can
 * show. Counters and capacities are summed; the hit rate is recomputed over the
 * combined totals so it is not an average of averages.
 */
export function combineStats(caches: CacheStats[]): CacheStats {
  const sum = (pick: (stats: CacheStats) => number) =>
    caches.reduce((total, stats) => total + pick(stats), 0);
  const hits = sum((stats) => stats.hits);
  const misses = sum((stats) => stats.misses);
  const requests = hits + misses;
  return {
    enabled: caches.some((stats) => stats.enabled),
    maxEntries: sum((stats) => stats.maxEntries),
    hits,
    misses,
    sets: sum((stats) => stats.sets),
    evictions: sum((stats) => stats.evictions),
    entries: sum((stats) => stats.entries),
    hitRate: requests === 0 ? 0 : Number((hits / requests).toFixed(3)),
  };
}

export class TtlCache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly enabledOption: boolean | (() => boolean);
  private readonly maxEntries: number;
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private evictions = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.enabledOption = options.enabled ?? true;
    const requested = options.maxEntries;
    this.maxEntries =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(1, Math.floor(requested))
        : 500;
    this.now = options.now ?? (() => Date.now());
  }

  get isEnabled(): boolean {
    return typeof this.enabledOption === "function"
      ? this.enabledOption()
      : this.enabledOption;
  }

  get<T>(key: string): T | undefined {
    if (!this.isEnabled) return undefined;

    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }

    // Refresh recency for the LRU eviction order.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (!this.isEnabled || ttlMs <= 0) return;

    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
    this.sets += 1;

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions += 1;
    }
  }

  /** Drop every entry whose key starts with `prefix`. Returns the count removed. */
  invalidate(prefix: string): number {
    let removed = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * Return the cached value or load it once. Parallel identical calls share a
   * single upstream request. Errors are never cached. `shouldCache` lets a
   * caller reject a *successful* response that carries a domain-level failure
   * (a null receipt, an error union), which must never be replayed later.
   */
  async wrap<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    if (!this.isEnabled || ttlMs <= 0) {
      return await loader();
    }

    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return (await pending) as T;

    const promise = (async () => {
      const value = await loader();
      if (shouldCache ? shouldCache(value) : true) {
        this.set(key, value, ttlMs);
      }
      return value;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return (await promise) as T;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      enabled: this.isEnabled,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      entries: this.store.size,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }
}
