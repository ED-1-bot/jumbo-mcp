/**
 * Promo digest: the receipt-mining half must actually produce terms.
 *
 * Regression guard for the 2026-10-16 fallout where `getReceiptDetails` threw
 * for every receipt id: the digest still ran, but `scanned.distinct_terms` was 0
 * and `matched` was empty, so it silently degraded to `account_offers` only.
 * That is the failure mode this file pins -- not a crash, a quiet empty result.
 *
 * Mocked HTTP only -- no live Jumbo calls, no real token store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "test-token";
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

const STORAGE_KEY = "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000.json";

const DETAIL_PAYLOAD = {
  receiptImage: {
    image: receiptDoc([
      "OMSCHRIJVING",
      "Halfvolle melk 2,19",
      "Bananen 1,99",
      "Totaal 4,18",
    ]),
    type: "json",
    receiptPoints: { earned: 4, newBalance: 14, oldBalance: 10, redeemed: 0 },
  },
  store: { name: "Jumbo Test" },
  purchaseEndOn: recent(1),
  receiptSource: "DIGITAL",
  customerDetails: { customerId: "c1", loyaltyCard: { number: "123" } },
};

/**
 * One recent receipt that the detail endpoint resolves normally. Nothing is on
 * offer and there are no account offers, so every mined term must surface in
 * `not_matched` -- which is exactly how we prove the terms were produced.
 */
function handlerDetailResolves(body: any) {
  switch (op(body)) {
    case "GetReceiptOverview":
      // The digest paginates until it reaches maxReceipts, so only the first
      // page may carry data -- otherwise every page yields the same receipt.
      if (!body.query.includes("page: 0")) {
        return json({
          data: {
            receiptOverview: {
              totalResults: 1,
              pageSize: 25,
              currentPage: 1,
              receipts: [],
            },
          },
        });
      }
      return json({
        data: {
          receiptOverview: {
            totalResults: 1,
            pageSize: 25,
            currentPage: 0,
            receipts: [
              {
                transactionId: STORAGE_KEY,
                purchaseEndOn: recent(1),
                receiptSource: "DIGITAL",
                store: { storeId: "s1", name: "Jumbo Test" },
                pointBalance: 14,
              },
            ],
          },
        },
      });
    case "GetDigitalReceipt":
      return json({ data: { receipt: DETAIL_PAYLOAD } });
    case "PromoDigestSearch":
      return json({ data: { searchProducts: { count: 0, products: [] } } });
    case "PromoDigestCustomerPromotions":
      return json({ data: { getCustomerPromotions: [] } });
    default:
      throw new Error("unexpected operation " + op(body));
  }
}

test("digest: a working receipt fetch produces distinct terms", async () => {
  installFetch(handlerDetailResolves);
  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 1, maxReceipts: 5 });

  // The receipt was mined, not skipped.
  assert.equal(d.scanned.receipts_scanned, 1);
  // This is the headline regression: 0 terms meant every detail fetch threw.
  assert.equal(d.scanned.distinct_terms, 2);
  assert.equal(d.scanned.frequent_terms, 2);

  // Nothing is on offer, so the two terms must be reported as not matched
  // rather than vanishing -- proof they flowed through the pipeline.
  assert.equal(d.not_matched_count, 2);
  assert.deepEqual([...d.not_matched].sort(), ["Bananen", "Halfvolle melk"]);
  assert.equal(d.matched_count, 0);
});

test("digest: id-form fallback keeps the receipt half alive when the key form is unknown", async () => {
  installFetch((body) => {
    if (op(body) === "GetDigitalReceipt") {
      // The detail endpoint rejects the full storage key but resolves on the
      // suffix-less form -- the shape bug that used to zero out the digest.
      const sent = body?.variables?.transactionId;
      return json({
        data: {
          receipt:
            sent === "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000"
              ? DETAIL_PAYLOAD
              : null,
        },
      });
    }
    return handlerDetailResolves(body);
  });

  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 1, maxReceipts: 5 });

  assert.equal(d.scanned.receipts_scanned, 1);
  assert.equal(d.scanned.distinct_terms, 2);
  assert.equal(d.not_matched_count, 2);
});

test("digest: every detail fetch failing is still visible as zero terms, not as a crash", async () => {
  installFetch((body) => {
    if (op(body) === "GetDigitalReceipt") {
      return json({ data: { receipt: null } });
    }
    return handlerDetailResolves(body);
  });

  const client = new JumboClient();
  const d = await client.getPromoDigest({ days: 90, minTimes: 1, maxReceipts: 5 });

  // The digest degrades instead of throwing, but the degradation is measurable:
  // this is the exact symptom Robert saw live, now pinned as a known state.
  assert.equal(d.scanned.receipts_scanned, 1);
  assert.equal(d.scanned.distinct_terms, 0);
  assert.equal(d.scanned.frequent_terms, 0);
  assert.equal(d.matched_count, 0);
});
