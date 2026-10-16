/**
 * Promo-digest tests. Mocked HTTP only — no live Jumbo calls.
 *
 * The digest is a read-only orchestration: receipts -> frequency -> product
 * search -> offers. These tests pin the shape of each hop, the not_matched
 * contract, and the "never a write" invariant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient } = await import("../src/client.js");

type Call = { op: string | undefined; body: any };
let calls: Call[] = [];

const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

function installFetch(handler: (body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ op: op(body), body });
    return handler(body);
  };
}
function json(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}
const opsSeen = () => calls.map((c) => c.op);

/** Build the JSON envelope the digital-receipt parser expects. */
function receiptDoc(lines: string[]): string {
  return JSON.stringify({
    documents: [
      {
        documents: [
          {
            printSections: [
              {
                textObjects: [
                  {
                    textLines: lines.map((t) => ({ texts: [{ text: t }] })),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

const recent = (daysAgo = 1) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const PRODUCT_WITH_PROMO = {
  sku: "SKU-MELK",
  title: "Jumbo Halfvolle melk 1L",
  link: "/producten/halfvolle-melk",
  category: "Zuivel, eieren, boter",
  price: { price: 219, promoPrice: 169, pricePerUnit: { price: 169, unit: "L" } },
  availability: { isAvailable: true },
  promotions: [
    {
      id: "promo-1",
      group: "actieprijs",
      tags: [{ text: "2e halve prijs" }],
      start: { date: "2026-10-13" },
      end: { date: "2026-10-19" },
      durationTexts: { shortTitle: "t/m zo" },
      volumeDiscounts: [{ discount: 50, volume: 2 }],
      maxPromotionQuantity: 4,
    },
  ],
};

const PRODUCT_NO_PROMO = {
  sku: "SKU-BAN",
  title: "Jumbo Bananen",
  link: "/producten/bananen",
  category: "Groente en fruit",
  price: { price: 199, promoPrice: null, pricePerUnit: { price: 199, unit: "kg" } },
  availability: { isAvailable: true },
  promotions: [],
};

/** Two recent receipts: melk x2, bananen x2, brood x1. */
function defaultHandler(body: any) {
  switch (op(body)) {
    case "GetReceiptOverview":
      if (body.query.includes("page: 0")) {
        return json({
          data: {
            receiptOverview: {
              totalResults: 2,
              pageSize: 25,
              currentPage: 0,
              receipts: [
                { transactionId: "t1", purchaseEndOn: recent(1), receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo Test" }, pointBalance: 10 },
                { transactionId: "t2", purchaseEndOn: recent(5), receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo Test" }, pointBalance: 8 },
              ],
            },
          },
        });
      }
      return json({ data: { receiptOverview: { totalResults: 2, pageSize: 25, currentPage: 1, receipts: [] } } });
    case "GetDigitalReceipt": {
      const id = body.variables?.transactionId;
      const lines =
        id === "t1"
          ? ["OMSCHRIJVING", "Halfvolle melk 2,19", "Bananen 1,99", "Brood 1,49", "Totaal 5,67"]
          : ["OMSCHRIJVING", "Halfvolle melk 2,19", "Bananen 1,99", "Totaal 4,18"];
      return json({
        data: {
          receipt: {
            receiptImage: { image: receiptDoc(lines), type: "json" },
            store: { name: "Jumbo Test" },
            purchaseEndOn: recent(1),
            receiptSource: "DIGITAL",
          },
        },
      });
    }
    case "PromoDigestSearch": {
      const term = body.variables?.input?.searchTerms;
      if (term === "Halfvolle melk") {
        return json({ data: { searchProducts: { count: 1, products: [PRODUCT_WITH_PROMO] } } });
      }
      if (term === "Bananen") {
        return json({ data: { searchProducts: { count: 1, products: [PRODUCT_NO_PROMO] } } });
      }
      return json({ data: { searchProducts: { count: 0, products: [] } } });
    }
    case "PromoDigestCustomerPromotions":
      return json({
        data: {
          getCustomerPromotions: [
            {
              id: "cp1",
              active: true,
              description: "€3 korting op je bestelling",
              expirationDate: "2026-10-31",
              eurosDiscount: 300,
              percentageDiscount: null,
              minimumSpent: 2500,
              startDate: "2026-10-01",
              title: "Persoonlijke korting",
            },
          ],
        },
      });
    default:
      throw new Error("unexpected operation " + op(body));
  }
}

test("digest: mines frequency, matches offers, reports was/now + validity + unit price", async () => {
  installFetch(defaultHandler);
  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 2 });

  assert.equal(d.matched_count, 1);
  const row = d.matched[0];
  assert.equal(row.term, "Halfvolle melk");
  assert.equal(row.times_bought, 2);
  assert.equal(row.product?.sku, "SKU-MELK");
  assert.equal(row.was_price, 219);
  assert.equal(row.now_price, 169);
  assert.equal(row.discount, 50);
  assert.equal(row.discount_percent, 23);
  assert.equal(row.unit_price, 169);
  assert.equal(row.unit, "L");
  assert.deepEqual(row.promo_types, ["2e halve prijs"]);
  assert.equal(row.valid_from, "2026-10-13");
  assert.equal(row.valid_until, "2026-10-19");
  assert.equal(row.promotions[0].volume_discounts[0].volume, 2);
  assert.equal(row.promotions[0].max_promotion_quantity, 4);
  assert.equal(row.is_available, true);

  // Frequent but not on offer -> not_matched, never silently dropped.
  assert.deepEqual(d.not_matched, ["Bananen"]);
  assert.equal(d.not_matched_count, 1);

  // Brood was bought once -> below min_times, excluded entirely.
  assert.equal(d.matched.some((m) => m.term === "Brood"), false);
  assert.equal(d.not_matched.includes("Brood"), false);

  assert.equal(d.scanned.receipts_scanned, 2);
  assert.equal(d.scanned.receipts_available, 2);
  assert.equal(d.scanned.frequent_terms, 2);

  // Account-level offers are supplementary context.
  assert.equal(d.account_offers.length, 1);
  assert.equal(d.account_offers[0].euros_discount, 300);
});

test("digest: is read-only — only the four read operations are issued", async () => {
  installFetch(defaultHandler);
  const client = new JumboClient();
  await client.getPromoDigest({});
  for (const o of opsSeen()) {
    assert.ok(
      ["GetReceiptOverview", "GetDigitalReceipt", "PromoDigestSearch", "PromoDigestCustomerPromotions"].includes(o as string),
      `unexpected op ${o}`
    );
  }
  assert.equal(opsSeen().some((o) => String(o).startsWith("Mutation")), false);
  assert.equal(calls.some((c) => (c.body?.query || "").trim().startsWith("mutation")), false);
});

test("digest: category filter drops rows outside the category", async () => {
  installFetch(defaultHandler);
  const client = new JumboClient();
  const d = await client.getPromoDigest({ category: "groente" }); // melk is Zuivel -> filtered out entirely
  assert.equal(d.matched_count, 0);
  // Bananen is in "Groente en fruit" so it survives the filter, but carries no offer.
  assert.deepEqual(d.not_matched, ["Bananen"]);
  assert.equal(d.category, "groente");
});

test("digest: min_times is honoured (higher bar -> nothing frequent)", async () => {
  installFetch(defaultHandler);
  const client = new JumboClient();
  const d = await client.getPromoDigest({ minTimes: 5 });
  assert.equal(d.matched_count, 0);
  assert.equal(d.scanned.frequent_terms, 0);
});

test("digest: limit caps returned offers", async () => {
  installFetch(defaultHandler);
  const client = new JumboClient();
  const d = await client.getPromoDigest({ limit: 0 as any });
  // limit is a UX cap only; guard against a negative/zero slice producing surprises
  assert.equal(d.matched_count, 0);
});

test("digest: no receipts degrades to empty digest, no throw", async () => {
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
  const client = new JumboClient();
  const d = await client.getPromoDigest({});
  assert.equal(d.matched_count, 0);
  assert.equal(d.scanned.receipts_scanned, 0);
  assert.equal(d.scanned.distinct_terms, 0);
});

test("digest: malformed receipt image does not throw", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        return body.query.includes("page: 0")
          ? json({
              data: {
                receiptOverview: {
                  totalResults: 1,
                  pageSize: 25,
                  currentPage: 0,
                  receipts: [{ transactionId: "t1", purchaseEndOn: recent(1), receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo" }, pointBalance: 1 }],
                },
              },
            })
          : json({ data: { receiptOverview: { totalResults: 1, pageSize: 25, currentPage: 1, receipts: [] } } });
      case "GetDigitalReceipt":
        return json({ data: { receipt: { receiptImage: { image: "not-json-at-all", type: "json" }, store: { name: "Jumbo" }, purchaseEndOn: recent(1) } } });
      case "PromoDigestCustomerPromotions":
        return json({ data: { getCustomerPromotions: [] } });
      default:
        throw new Error("unexpected " + op(body));
    }
  });
  const client = new JumboClient();
  const d = await client.getPromoDigest({});
  assert.equal(d.matched_count, 0);
  assert.equal(d.scanned.receipts_scanned, 1);
});

test("digest: a failing customer-promotions call is noted, not fatal", async () => {
  installFetch((body) => {
    if (op(body) === "PromoDigestCustomerPromotions") {
      return json({ errors: [{ message: "UNAUTHORIZED" }] });
    }
    return defaultHandler(body);
  });
  const client = new JumboClient();
  const d = await client.getPromoDigest({});
  assert.equal(d.matched_count, 1); // product matching still worked
  assert.equal(d.account_offers.length, 0);
  assert.ok(d.notes.some((n) => n.includes("customer promotions unavailable")));
});

test("digest: a product-search failure marks the term not_matched instead of throwing", async () => {
  installFetch((body) => {
    if (op(body) === "PromoDigestSearch") {
      return json({ errors: [{ message: "search exploded" }] });
    }
    return defaultHandler(body);
  });
  const client = new JumboClient();
  const d = await client.getPromoDigest({});
  assert.equal(d.matched_count, 0);
  assert.deepEqual(d.not_matched.sort(), ["Bananen", "Halfvolle melk"]);
});

test("digest: multi-line items accumulate quantity and skip discount lines and container deposits", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        if (body.query.includes("page: 0")) {
          return json({
            data: {
              receiptOverview: {
                totalResults: 1,
                pageSize: 25,
                currentPage: 0,
                receipts: [
                  { transactionId: "t-mult", purchaseEndOn: recent(1), receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo Test" }, pointBalance: 10 },
                ],
              },
            },
          });
        }
        return json({ data: { receiptOverview: { totalResults: 1, pageSize: 25, currentPage: 1, receipts: [] } } });
      case "GetDigitalReceipt":
        return json({
          data: {
            receipt: {
              receiptImage: {
                image: receiptDoc([
                  "OMSCHRIJVING",
                  "Halfvolle melk",
                  "  3 X 1,69                            5,07",
                  "ACTIE MELK                           -1,00",
                  "STATIEGELD                            0,15",
                  "Totaal                                4,22",
                ]),
                type: "json",
              },
              store: { name: "Jumbo Test" },
              purchaseEndOn: recent(1),
              receiptSource: "DIGITAL",
            },
          },
        });
      case "PromoDigestSearch": {
        const term = body.variables?.input?.searchTerms;
        if (term === "Halfvolle melk") {
          return json({ data: { searchProducts: { count: 1, products: [PRODUCT_WITH_PROMO] } } });
        }
        return json({ data: { searchProducts: { count: 0, products: [] } } });
      }
      case "PromoDigestCustomerPromotions":
        return json({ data: { getCustomerPromotions: [] } });
      default:
        throw new Error("unexpected op " + op(body));
    }
  });

  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 2 });
  // Distinct terms must only be 1 (Halfvolle melk), NOT statiegeld or discounts
  assert.equal(d.scanned.distinct_terms, 1);
  assert.equal(d.matched_count, 1);
  assert.equal(d.matched[0].term, "Halfvolle melk");
  assert.equal(d.matched[0].times_bought, 3); // 3 units bought from multiplier
});

test("digest: searchProductForDigest falls back to stripped store brand on 0 hits", async () => {
  const searchedTerms: string[] = [];
  installFetch((body) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        if (body.query.includes("page: 0")) {
          return json({
            data: {
              receiptOverview: {
                totalResults: 1,
                pageSize: 25,
                currentPage: 0,
                receipts: [
                  { transactionId: "t-brand", purchaseEndOn: recent(1), receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo Test" }, pointBalance: 10 },
                ],
              },
            },
          });
        }
        return json({ data: { receiptOverview: { totalResults: 1, pageSize: 25, currentPage: 1, receipts: [] } } });
      case "GetDigitalReceipt":
        return json({
          data: {
            receipt: {
              receiptImage: {
                image: receiptDoc([
                  "OMSCHRIJVING",
                  "JUMBOS MARGHERITA 5,99",
                  "Totaal 5,99",
                ]),
                type: "json",
              },
              store: { name: "Jumbo Test" },
              purchaseEndOn: recent(1),
              receiptSource: "DIGITAL",
            },
          },
        });
      case "PromoDigestSearch": {
        const term = body.variables?.input?.searchTerms;
        searchedTerms.push(term);
        // Literal search fails, stripped fallback succeeds
        if (term === "JUMBOS MARGHERITA") {
          return json({ data: { searchProducts: { count: 0, products: [] } } });
        }
        if (term === "MARGHERITA") {
          return json({ data: { searchProducts: { count: 1, products: [PRODUCT_WITH_PROMO] } } });
        }
        return json({ data: { searchProducts: { count: 0, products: [] } } });
      }
      case "PromoDigestCustomerPromotions":
        return json({ data: { getCustomerPromotions: [] } });
      default:
        throw new Error("unexpected op " + op(body));
    }
  });

  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 1 });
  assert.equal(d.matched_count, 1);
  assert.deepEqual(searchedTerms, ["JUMBOS MARGHERITA", "MARGHERITA"]);
});
