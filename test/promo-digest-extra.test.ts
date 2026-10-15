/**
 * Promo-digest regression tests for the two review items: the promo-tag
 * dependency of `matched`, and the `digestPause` throttle. Mocked HTTP only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient } = await import("../src/client.js");

let calls: any[] = [];
const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

function installFetch(handler: (body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ op: op(body), body });
    return handler(body);
  };
}
function json(data: any) {
  return {
    ok: true,
    status: 200,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}
function receiptDoc(lines: string[]): string {
  return JSON.stringify({
    documents: [{ documents: [{ printSections: [{ textObjects: [{ textLines: lines.map((t) => ({ texts: [{ text: t }] })) }] }] }] }],
  });
}
const recent = (d = 1) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Two receipts, one frequent term ("Melk") bought twice. */
function handlerWithProduct(product: any) {
  return (body: any) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        return body.query.includes("page: 0")
          ? json({
              data: {
                receiptOverview: {
                  totalResults: 2,
                  pageSize: 25,
                  currentPage: 0,
                  receipts: [
                    { transactionId: "t1", purchaseEndOn: recent(1), receiptSource: "D", store: { storeId: "s", name: "J" }, pointBalance: 1 },
                    { transactionId: "t2", purchaseEndOn: recent(2), receiptSource: "D", store: { storeId: "s", name: "J" }, pointBalance: 1 },
                  ],
                },
              },
            })
          : json({ data: { receiptOverview: { totalResults: 2, pageSize: 25, currentPage: 1, receipts: [] } } });
      case "GetDigitalReceipt":
        return json({
          data: { receipt: { receiptImage: { image: receiptDoc(["OMSCHRIJVING", "Melk 2,19", "Totaal 2,19"]) }, store: { name: "J" }, purchaseEndOn: recent(1) } },
        });
      case "PromoDigestSearch":
        return json({ data: { searchProducts: { count: 1, products: product ? [product] : [] } } });
      case "PromoDigestCustomerPromotions":
        return json({ data: { getCustomerPromotions: [] } });
      default:
        throw new Error("unexpected " + op(body));
    }
  };
}

const BASE_PRODUCT = {
  sku: "SKU-MELK",
  title: "Jumbo Halfvolle melk 1L",
  link: "/producten/melk",
  category: "Zuivel, eieren, boter",
  availability: { isAvailable: true },
};

// ------------------------------------------------------ promo-tag dependency

test("matched requires a promotion tag: a lone price drop is NOT an offer", async () => {
  installFetch(
    handlerWithProduct({
      ...BASE_PRODUCT,
      // promoPrice < price, but no `promotions` entry -> must not be matched
      price: { price: 219, promoPrice: 169, pricePerUnit: { price: 169, unit: "L" } },
      promotions: [],
    })
  );
  const d = await new JumboClient().getPromoDigest({});
  assert.equal(d.matched_count, 0);
  assert.deepEqual(d.matched, []);
  assert.deepEqual(d.not_matched, ["Melk"]);
});

test("matched requires a promotion tag: promoPrice + a promotions entry IS an offer", async () => {
  installFetch(
    handlerWithProduct({
      ...BASE_PRODUCT,
      price: { price: 219, promoPrice: 169, pricePerUnit: { price: 169, unit: "L" } },
      promotions: [{ id: "p1", group: "actieprijs", tags: [{ text: "2e halve prijs" }], start: { date: "2026-10-13" }, end: { date: "2026-10-19" } }],
    })
  );
  const d = await new JumboClient().getPromoDigest({});
  assert.equal(d.matched_count, 1);
  assert.deepEqual(d.not_matched, []);
  assert.deepEqual(d.matched[0].promo_types, ["2e halve prijs"]);
});

// ------------------------------------------------------------------ throttle

test("digestPause: a jittered 120-200ms pause runs between fetches and searches", async () => {
  installFetch(
    handlerWithProduct({
      ...BASE_PRODUCT,
      price: { price: 219, promoPrice: 169, pricePerUnit: { price: 169, unit: "L" } },
      promotions: [{ id: "p1", tags: [{ text: "2e halve prijs" }] }],
    })
  );

  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  // Fake the clock: record the requested delay and run the continuation immediately
  // so the test stays fast while still proving the pause is issued.
  (globalThis as any).setTimeout = ((fn: any, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as any;

  try {
    const d = await new JumboClient().getPromoDigest({});
    assert.equal(d.matched_count, 1);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }

  // 2 receipt-detail fetches + 1 per-term search = 3 pauses.
  assert.equal(delays.length, 3, `expected 3 throttled pauses, saw ${delays.length}`);
  for (const ms of delays) {
    assert.ok(ms >= 120 && ms < 200, `pause ${ms}ms outside the 120-200ms window`);
  }
});

test("digestPause: no pause is issued when there is nothing to fetch", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        return json({ data: { receiptOverview: { totalResults: 0, pageSize: 25, currentPage: 0, receipts: [] } } });
      case "PromoDigestCustomerPromotions":
        return json({ data: { getCustomerPromotions: [] } });
      default:
        throw new Error("unexpected " + op(body));
    }
  });

  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((fn: any, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as any;
  try {
    const d = await new JumboClient().getPromoDigest({});
    assert.equal(d.scanned.receipts_scanned, 0);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }
  assert.equal(delays.length, 0);
});
