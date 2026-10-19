/**
 * Response cache tests for jumbo-mcp.
 *
 * The TtlCache module is mirrored from appie-mcp (same file, no shared npm
 * dependency yet), so its unit tests are mirrored too.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "test-jumbo-token";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient, CACHE_TTL } = await import("../src/client.js");
const { TtlCache, cacheKey, stableStringify } = await import("../src/cache.js");

describe("cache.ts - TtlCache", () => {
  it("stores a value and returns it before the TTL expires", () => {
    let now = 1_000;
    const cache = new TtlCache({ now: () => now });

    cache.set("a", { value: 42 }, 1000);
    assert.deepEqual(cache.get("a"), { value: 42 });

    now += 999;
    assert.deepEqual(cache.get("a"), { value: 42 });
  });

  it("expires an entry once the TTL has passed", () => {
    let now = 1_000;
    const cache = new TtlCache({ now: () => now });

    cache.set("a", "stale", 100);
    now += 101;

    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.stats().misses, 1);
  });

  it("evicts the least recently used entry when the cap is reached", () => {
    const cache = new TtlCache({ maxEntries: 2 });

    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.get("a");
    cache.set("c", 3, 10_000);

    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.stats().evictions, 1);
  });

  it("invalidates every entry under a key prefix", () => {
    const cache = new TtlCache();

    cache.set("POST graphql GetStoreList 1", "a", 10_000);
    cache.set("POST graphql GetStoreList 2", "b", 10_000);
    cache.set("POST graphql ProductDetail 3", "c", 10_000);

    const removed = cache.invalidate("POST graphql GetStoreList");

    assert.equal(removed, 2);
    assert.equal(cache.get("POST graphql GetStoreList 1"), undefined);
    assert.equal(cache.get("POST graphql ProductDetail 3"), "c");
  });

  it("coalesces concurrent identical loads into a single upstream call", async () => {
    const cache = new TtlCache();
    let loads = 0;

    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return "value";
    };

    const results = await Promise.all([
      cache.wrap("k", 10_000, loader),
      cache.wrap("k", 10_000, loader),
      cache.wrap("k", 10_000, loader),
    ]);

    assert.equal(loads, 1);
    assert.deepEqual(results, ["value", "value", "value"]);
  });

  it("never caches a failed load", async () => {
    const cache = new TtlCache();
    let attempts = 0;

    const loader = async () => {
      attempts += 1;
      throw new Error("upstream exploded");
    };

    await assert.rejects(() => cache.wrap("k", 10_000, loader));
    await assert.rejects(() => cache.wrap("k", 10_000, loader));

    assert.equal(attempts, 2);
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.stats().sets, 0);
  });

  it("reports hit and miss statistics", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 10_000);

    cache.get("a");
    cache.get("a");
    cache.get("missing");

    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.entries, 1);
    assert.equal(stats.hitRate, 0.667);
  });

  it("is inert when disabled", async () => {
    const cache = new TtlCache({ enabled: false });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return "value";
    };

    await cache.wrap("k", 10_000, loader);
    await cache.wrap("k", 10_000, loader);

    assert.equal(loads, 2);
    assert.equal(cache.stats().enabled, false);
  });

  it("builds stable keys regardless of parameter order", () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.equal(
      cacheKey("POST graphql X", [{ b: 1, a: 2 }]),
      cacheKey("POST graphql X", [{ a: 2, b: 1 }])
    );
    assert.notEqual(cacheKey("POST graphql X", [1]), cacheKey("POST graphql X", [2]));
  });
});

describe("client.ts - response cache", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalCacheEnv: string | undefined;
  let calls: string[];

  const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCacheEnv = process.env.JUMBO_MCP_CACHE;
    calls = [];

    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(op(body) || "raw");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { ok: true } };
        },
        async text() {
          return JSON.stringify({ data: { ok: true } });
        },
      };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCacheEnv !== undefined) {
      process.env.JUMBO_MCP_CACHE = originalCacheEnv;
    } else {
      delete process.env.JUMBO_MCP_CACHE;
    }
  });

  it("caches allowlisted catalogue operations", async () => {
    const client = new JumboClient();

    await client.executeGraphql("query GetStoreList { stores { id } }");
    await client.executeGraphql("query GetStoreList { stores { id } }");

    assert.equal(calls.length, 1);
    assert.equal(client.cacheStats().hits, 1);
  });

  it("never caches the receipt overview list", async () => {
    const client = new JumboClient();

    await client.executeGraphql("query GetReceiptOverview { receiptOverview { id } }");
    await client.executeGraphql("query GetReceiptOverview { receiptOverview { id } }");

    assert.equal(calls.length, 2);
  });

  it("never caches live customer state", async () => {
    const client = new JumboClient();

    for (const operation of ["GetProfile", "GetShoppingList", "GetBalance", "GetStamps", "ActiveBasket"]) {
      await client.executeGraphql(`query ${operation} { x }`);
      await client.executeGraphql(`query ${operation} { x }`);
    }

    assert.equal(calls.length, 10);
    assert.equal(client.cacheStats().entries, 0);
  });

  it("caches a closed receipt and its deposits", async () => {
    const client = new JumboClient();

    await client.executeGraphql("query GetDigitalReceipt { receipt { id } }", { id: "r-1" });
    await client.executeGraphql("query GetDigitalReceipt { receipt { id } }", { id: "r-1" });
    assert.equal(calls.length, 1);

    await client.executeGraphql("query GetDigitalReceipt { receipt { id } }", { id: "r-2" });
    assert.equal(calls.length, 2, "a different receipt is a different cache entry");
  });

  it("does not share a cache entry between different variables", async () => {
    const client = new JumboClient();

    await client.executeGraphql("query ProductDetail { p }", { sku: "a" });
    await client.executeGraphql("query ProductDetail { p }", { sku: "b" });

    assert.equal(calls.length, 2);
  });

  it("refetches once the TTL has expired", async () => {
    let now = 1_000_000;
    const cache = new TtlCache({ now: () => now });
    const client = new JumboClient(cache);

    await client.executeGraphql("query GetStoreList { stores { id } }");
    await client.executeGraphql("query GetStoreList { stores { id } }");
    assert.equal(calls.length, 1);

    now += CACHE_TTL.catalog + 1;
    await client.executeGraphql("query GetStoreList { stores { id } }");
    assert.equal(calls.length, 2);
  });

  it("bypasses the cache entirely when JUMBO_MCP_CACHE is off", async () => {
    process.env.JUMBO_MCP_CACHE = "off";
    const client = new JumboClient();

    await client.executeGraphql("query GetStoreList { stores { id } }");
    await client.executeGraphql("query GetStoreList { stores { id } }");

    assert.equal(calls.length, 2);
    assert.equal(client.cacheStats().enabled, false);
  });

  it("coalesces parallel identical calls into one upstream request", async () => {
    const client = new JumboClient();

    await Promise.all([
      client.executeGraphql("query GetStoreList { stores { id } }"),
      client.executeGraphql("query GetStoreList { stores { id } }"),
      client.executeGraphql("query GetStoreList { stores { id } }"),
    ]);

    assert.equal(calls.length, 1);
  });

  it("does not cache a GraphQL error response", async () => {
    const client = new JumboClient();
    let attempts = 0;

    (globalThis as any).fetch = async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { errors: [{ message: "boom" }] };
        },
        async text() {
          return JSON.stringify({ errors: [{ message: "boom" }] });
        },
      };
    };

    await assert.rejects(() => client.executeGraphql("query GetStoreList { stores { id } }"));
    await assert.rejects(() => client.executeGraphql("query GetStoreList { stores { id } }"));

    assert.equal(attempts, 2);
    assert.equal(client.cacheStats().entries, 0);
  });
});
