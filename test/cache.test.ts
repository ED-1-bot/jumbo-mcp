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

const { JumboClient, CACHE_TTL, GEOCODE_CACHE_MAX_ENTRIES } = await import("../src/client.js");
const { TtlCache, cacheKey, stableStringify, combineStats } = await import("../src/cache.js");
const { CUSTOMER_ID_CLAIM } = await import("../src/auth.js");

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

  it("sums counters across caches and recomputes the hit rate", () => {
    const combined = combineStats([
      {
        enabled: true,
        maxEntries: 500,
        hits: 3,
        misses: 1,
        sets: 2,
        evictions: 0,
        entries: 2,
        hitRate: 0.75,
      },
      {
        enabled: true,
        maxEntries: 200,
        hits: 1,
        misses: 3,
        sets: 3,
        evictions: 1,
        entries: 3,
        hitRate: 0.25,
      },
    ]);

    assert.deepEqual(combined, {
      enabled: true,
      maxEntries: 700,
      hits: 4,
      misses: 4,
      sets: 5,
      evictions: 1,
      entries: 5,
      hitRate: 0.5,
    });
  });

  it("reports an empty combined snapshot as disabled with a zero hit rate", () => {
    assert.deepEqual(combineStats([]), {
      enabled: false,
      maxEntries: 0,
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      entries: 0,
      hitRate: 0,
    });
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
      const name = op(body);
      calls.push(name || "raw");
      const data: any = { ok: true };
      if (name === "GetDigitalReceipt") data.receipt = { receiptImage: { image: "x" } };
      if (name === "GetDeposits") {
        data.returnedDeposits = { __typename: "ReturnedDepositsResponseSuccess" };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { data };
        },
        async text() {
          return JSON.stringify({ data });
        },
      };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.JUMBO_TOKEN = "test-jumbo-token";
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

  it("does not cache a receipt the API cannot resolve", async () => {
    const client = new JumboClient();
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(op(body) || "raw");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { receipt: null } };
        },
        async text() {
          return JSON.stringify({ data: { receipt: null } });
        },
      };
    };

    await client.executeGraphql("query GetDigitalReceipt { receipt { id } }", { id: "r-1" });
    await client.executeGraphql("query GetDigitalReceipt { receipt { id } }", { id: "r-1" });

    assert.equal(calls.length, 2, "a null receipt must stay retryable");
    assert.equal(client.cacheStats().entries, 0);
  });

  it("does not cache a deposits error union", async () => {
    const client = new JumboClient();
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(op(body) || "raw");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: { returnedDeposits: { __typename: "ReturnedDepositsError" } },
          };
        },
        async text() {
          return JSON.stringify({
            data: { returnedDeposits: { __typename: "ReturnedDepositsError" } },
          });
        },
      };
    };

    await client.executeGraphql("query GetDeposits { deposits { sku } }", { orderId: "o-1" });
    await client.executeGraphql("query GetDeposits { deposits { sku } }", { orderId: "o-1" });

    assert.equal(calls.length, 2, "an error union must not be replayed from cache");
    assert.equal(client.cacheStats().entries, 0);
  });

  it("scopes cache entries to the authenticated principal", async () => {
    process.env.JUMBO_TOKEN = "principal-a";
    const client = new JumboClient();

    await client.executeGraphql("query GetStoreList { stores { id } }");
    await client.executeGraphql("query GetStoreList { stores { id } }");
    assert.equal(calls.length, 1);

    // A re-login under another account must not read the previous cache.
    process.env.JUMBO_TOKEN = "principal-b";
    await client.executeGraphql("query GetStoreList { stores { id } }");
    assert.equal(calls.length, 2);
    assert.equal(client.cacheStats().entries, 1);
  });

  it("falls back to the default size cap when the configured one is invalid", () => {
    const cache = new TtlCache({ maxEntries: Number("1k") });
    assert.equal(cache.stats().maxEntries, 500);
  });

  it("does not share a cache entry between different variables", async () => {
    const client = new JumboClient();

    await client.executeGraphql("query ProductDetail { p }", { sku: "a" });
    await client.executeGraphql("query ProductDetail { p }", { sku: "b" });

    assert.equal(calls.length, 2);
  });

  it("does not cache a product the API cannot resolve", async () => {
    const client = new JumboClient();
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(op(body) || "raw");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { product: null } };
        },
        async text() {
          return JSON.stringify({ data: { product: null } });
        },
      };
    };

    await client.executeGraphql("query ProductDetail { p }", { sku: "gone" });
    await client.executeGraphql("query ProductDetail { p }", { sku: "gone" });

    assert.equal(calls.length, 2, "an unresolved product must stay retryable");
    assert.equal(client.cacheStats().entries, 0);
  });

  it("does not share a cache entry between different GraphQL documents", async () => {
    const client = new JumboClient();

    // Same operation name, same variables, different selection sets: the
    // responses carry different fields and must not share an entry.
    await client.executeGraphql(
      "query SearchProductsByKeyword { products { id } }",
      { query: "melk" }
    );
    await client.executeGraphql(
      "query SearchProductsByKeyword { products { name url } }",
      { query: "melk" }
    );

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

  it("does not cache an empty deposits payload", async () => {
    const client = new JumboClient();
    let attempts = 0;

    (globalThis as any).fetch = async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { deposits: [], returnedDeposits: null } };
        },
        async text() {
          return JSON.stringify({ data: { deposits: [], returnedDeposits: null } });
        },
      };
    };

    const first = await client.getDeposits("order-1");
    const second = await client.getDeposits("order-1");

    assert.equal(attempts, 2, "a null returnedDeposits must stay retryable");
    assert.deepEqual(first.returned.items, []);
    assert.deepEqual(second.returned.items, []);
  });

  it("caches a resolved deposits payload", async () => {
    const client = new JumboClient();
    let attempts = 0;
    const payload = {
      data: {
        deposits: [],
        returnedDeposits: {
          __typename: "ReturnedDepositsResponseSuccess",
          returnedDeposits: [{ sku: "s1", price: { amount: 0.25, currency: "EUR" }, returnedByCustomerQuantity: 1 }],
          returnedDepositsTotalAmount: { amount: 0.25, currency: "EUR" },
        },
      },
    };

    (globalThis as any).fetch = async () => {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
        async text() {
          return JSON.stringify(payload);
        },
      };
    };

    const first = await client.getDeposits("order-2");
    const second = await client.getDeposits("order-2");

    assert.equal(attempts, 1);
    assert.equal(first.returned.total, 0.25);
    assert.deepEqual(second.returned, first.returned);
  });

  it("sends the credentials the cache key was built from", async () => {
    const client = new JumboClient();
    const sentAuthorization: string[] = [];

    // Drop the credential while the request is in flight: a second credential
    // resolution would throw instead of sending, which is exactly the drift the
    // snapshot prevents.
    (globalThis as any).fetch = async (_url: string, init: any) => {
      sentAuthorization.push(init.headers.Authorization);
      delete process.env.JUMBO_TOKEN;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { storesByListing: [] } };
        },
        async text() {
          return JSON.stringify({ data: { storesByListing: [] } });
        },
      };
    };

    await client.executeGraphql("query GetStoreList { stores { id } }");

    assert.equal(sentAuthorization.length, 1);
    assert.equal(sentAuthorization[0], "Bearer test-jumbo-token");
  });

  it("reports the response-cache cap apart from the combined capacity", () => {
    const client = new JumboClient(new TtlCache({ maxEntries: 100 }));

    assert.equal(client.responseCacheMaxEntries, 100);
    assert.equal(client.cacheStats().maxEntries, 100 + GEOCODE_CACHE_MAX_ENTRIES);
  });

  it("keeps the cache across a token refresh for the same customer", async () => {
    const client = new JumboClient();
    const jwt = (claims: Record<string, unknown>) =>
      `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const firstToken = jwt({ [CUSTOMER_ID_CLAIM]: "customer-1", jti: "first" });
    const refreshedToken = jwt({ [CUSTOMER_ID_CLAIM]: "customer-1", jti: "second" });
    const otherCustomerToken = jwt({ [CUSTOMER_ID_CLAIM]: "customer-2", jti: "third" });
    const query = "query GetStoreList { stores { id } }";

    await client.executeGraphql(query, undefined, "JUMBO_WEB-loyalty", true, firstToken);
    await client.executeGraphql(query, undefined, "JUMBO_WEB-loyalty", true, refreshedToken);
    assert.equal(calls.length, 1, "a refreshed token for the same account must keep the cache");

    await client.executeGraphql(query, undefined, "JUMBO_WEB-loyalty", true, otherCustomerToken);
    assert.equal(calls.length, 2, "a different account must not read the previous account's entry");
  });

  it("applies the kill switch to an injected cache", async () => {
    process.env.JUMBO_MCP_CACHE = "off";
    const client = new JumboClient(new TtlCache());

    await client.executeGraphql("query GetStoreList { stores { id } }");
    await client.executeGraphql("query GetStoreList { stores { id } }");

    assert.equal(calls.length, 2);
    assert.equal(client.cacheStats().enabled, false);
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

describe("client.ts - geocode cache reporting", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const jsonResponse = (payload: unknown) => ({
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  });

  it("includes geocode activity in cacheStats", async () => {
    let nominatimLookups = 0;

    (globalThis as any).fetch = async (url: string) => {
      if (String(url).includes("nominatim")) {
        nominatimLookups += 1;
        return jsonResponse([{ lat: "52.0286", lon: "5.0833" }]);
      }
      return jsonResponse({ data: { storesByCoordinates: { stores: [], totalCount: 0 } } });
    };

    // The instance cache is disabled, so every counter delta below can only come
    // from the module-level geocode cache.
    const client = new JumboClient(new TtlCache({ enabled: false }));
    const before = client.cacheStats();

    await client.searchStores({ query: "Nieuwegein" });
    await client.searchStores({ query: "Nieuwegein" });

    const after = client.cacheStats();
    assert.equal(nominatimLookups, 1, "the second search must reuse the cached coordinates");
    assert.equal(after.misses - before.misses, 1);
    assert.equal(after.sets - before.sets, 1);
    assert.equal(after.hits - before.hits, 1);
    assert.equal(after.entries - before.entries, 1);
  });
});
