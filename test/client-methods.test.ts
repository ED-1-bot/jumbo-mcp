/**
 * Direct client-layer tests for methods that had no dedicated test: profile,
 * receipts, balance, stores, recommendations, product search, receipt parsing.
 * Mocked HTTP only — no live Jumbo calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient } = await import("../src/client.js");

type Call = { op: string | undefined; client: string | undefined; body: any };
let calls: Call[] = [];

const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

function installFetch(handler: (body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ op: op(body), client: init?.headers?.["apollographql-client-name"], body });
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
          { printSections: [{ textObjects: [{ textLines: lines.map((t) => ({ texts: [{ text: t }] })) }] }] },
        ],
      },
    ],
  });
}

// ------------------------------------------------------------------- getProfile

test("getProfile: maps the GraphQL profile shape", async () => {
  installFetch(() =>
    json({
      data: {
        getProfile: {
          customerId: "cust-1",
          name: { givenName: "Robert" },
          loyaltyCard: { number: "9999" },
          checkoutPreferences: { printReceipt: false, promotionStamps: true },
          digitalStamps: { optIn: true },
        },
      },
    })
  );
  const p = await new JumboClient().getProfile();
  assert.deepEqual(p, {
    name: "Robert",
    customer_id: "cust-1",
    loyalty_card_number: "9999",
    digital_receipt_enabled: true,
    digital_stamps_opt_in: true,
  });
});

test("getProfile: printReceipt:true flips digital_receipt_enabled off", async () => {
  installFetch(() =>
    json({ data: { getProfile: { customerId: "c", name: { givenName: "X" }, checkoutPreferences: { printReceipt: true } } } })
  );
  const p = await new JumboClient().getProfile();
  assert.equal(p.digital_receipt_enabled, false);
  assert.equal(p.digital_stamps_opt_in, false);
});

test("getProfile: malformed payload degrades to empty fields, never throws", async () => {
  installFetch(() => json({ data: {} }));
  const p = await new JumboClient().getProfile();
  assert.deepEqual(p, {
    name: "",
    customer_id: "",
    loyalty_card_number: "",
    digital_receipt_enabled: false,
    digital_stamps_opt_in: false,
  });
});

// ------------------------------------------------------------------ listReceipts

test("listReceipts: maps overview rows and uses the orders client channel", async () => {
  installFetch(() =>
    json({
      data: {
        receiptOverview: {
          totalResults: 42,
          pageSize: 10,
          currentPage: 0,
          receipts: [
            { transactionId: "t1", purchaseEndOn: "2026-10-01T10:00:00Z", receiptSource: "DIGITAL", store: { storeId: "s1", name: "Jumbo Utrecht" }, pointBalance: 15 },
          ],
        },
      },
    })
  );
  const r = await new JumboClient().listReceipts(0, 10);
  assert.equal(r.total_results, 42);
  assert.equal(r.page, 0);
  assert.equal(r.page_size, 10);
  assert.deepEqual(r.receipts[0], {
    transaction_id: "t1",
    datetime: "2026-10-01T10:00:00Z",
    store: "Jumbo Utrecht",
    store_id: "s1",
    points_earned: 15,
  });
  assert.equal(calls[0].client, "JUMBO_WEB-orders");
});

test("listReceipts: missing overview yields empty receipts, never throws", async () => {
  installFetch(() => json({ data: {} }));
  const r = await new JumboClient().listReceipts();
  assert.deepEqual(r.receipts, []);
  assert.equal(r.total_results, undefined);
});

// -------------------------------------------------------------- getReceiptDetails

test("getReceiptDetails: parses the embedded receipt document", async () => {
  installFetch(() =>
    json({
      data: {
        receipt: {
          receiptImage: {
            image: receiptDoc([
              "OMSCHRIJVING",
              "Halfvolle melk 2,19",
              "Brood P 1,49",
              "Totaal 3,68",
              "PIN",
              "BTW overzicht",
              "9% 0,30",
              "Totaal 3,68",
            ]),
            type: "json",
            receiptPoints: { earned: 12 },
          },
          store: { name: "Jumbo Utrecht" },
          purchaseEndOn: "2026-10-01T10:00:00Z",
          receiptSource: "DIGITAL",
        },
      },
    })
  );
  const d = await new JumboClient().getReceiptDetails("t1");
  assert.equal(d.transaction_id, "t1");
  assert.equal(d.total, 3.68);
  assert.equal(d.payment_method, "PIN");
  assert.equal(d.items.length, 2);
  assert.deepEqual(d.items[0], { name: "Halfvolle melk", price: 2.19, is_promotion: false });
  assert.deepEqual(d.items[1], { name: "Brood", price: 1.49, is_promotion: true });
  assert.deepEqual(d.vat_overview, ["9% 0,30"]);
  assert.equal(d.points_earned, 12);
});

test("getReceiptDetails: unknown receipt id throws a clear error", async () => {
  installFetch(() => json({ data: { receipt: null } }));
  await assert.rejects(() => new JumboClient().getReceiptDetails("missing"), /Receipt not found/);
});

test("getReceiptDetails: unparseable image returns an empty item list, no throw", async () => {
  installFetch(() =>
    json({ data: { receipt: { receiptImage: { image: "not-json" }, store: { name: "Jumbo" }, purchaseEndOn: "x" } } })
  );
  const d = await new JumboClient().getReceiptDetails("t1");
  assert.deepEqual(d.items, []);
  assert.equal(d.total, null);
});

// ------------------------------------------------------------------ searchReceipts

test("searchReceipts: scans receipts and returns only matching items", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetReceiptOverview":
        return json({
          data: {
            receiptOverview: {
              totalResults: 2,
              pageSize: 10,
              currentPage: 0,
              receipts: [
                { transactionId: "t1", purchaseEndOn: "d1", receiptSource: "D", store: { storeId: "s", name: "Jumbo" }, pointBalance: 1 },
                { transactionId: "t2", purchaseEndOn: "d2", receiptSource: "D", store: { storeId: "s", name: "Jumbo" }, pointBalance: 1 },
              ],
            },
          },
        });
      case "GetDigitalReceipt": {
        const lines =
          body.variables.transactionId === "t1"
            ? ["OMSCHRIJVING", "Havermelk 1,29", "Brood 1,49", "Totaal 2,78"]
            : ["OMSCHRIJVING", "Kaas 3,99", "Totaal 3,99"];
        return json({ data: { receipt: { receiptImage: { image: receiptDoc(lines) }, store: { name: "Jumbo" }, purchaseEndOn: "d" } } });
      }
      default:
        throw new Error("unexpected " + op(body));
    }
  });
  const r = await new JumboClient().searchReceipts("havermelk", 10);
  assert.equal(r.query, "havermelk");
  assert.equal(r.receipts_scanned, 2);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].transaction_id, "t1");
  assert.deepEqual(r.matches[0].matched_items.map((i) => i.name), ["Havermelk"]);
});

test("searchReceipts: a failing detail fetch is skipped, not fatal", async () => {
  installFetch((body) => {
    if (op(body) === "GetReceiptOverview") {
      return json({
        data: {
          receiptOverview: {
            totalResults: 1,
            pageSize: 10,
            currentPage: 0,
            receipts: [{ transactionId: "t1", purchaseEndOn: "d", receiptSource: "D", store: { storeId: "s", name: "J" }, pointBalance: 1 }],
          },
        },
      });
    }
    return json({ errors: [{ message: "receipt exploded" }] });
  });
  const r = await new JumboClient().searchReceipts("melk", 10);
  assert.deepEqual(r.matches, []);
  assert.equal(r.receipts_scanned, 1);
});

// --------------------------------------------------------------------- getBalance

test("getBalance: returns the balance and defaults to 0 when absent", async () => {
  installFetch(() => json({ data: { getBalance: { balance: 1234 } } }));
  assert.deepEqual(await new JumboClient().getBalance(), { balance: 1234 });

  installFetch(() => json({ data: {} }));
  assert.deepEqual(await new JumboClient().getBalance(), { balance: 0 });
});

// ------------------------------------------------------------------- searchStores

test("searchStores: maps stores, distance and opening hours (city lookup, no geocoding fetch)", async () => {
  installFetch((body) => {
    assert.deepEqual(body.variables, { input: { latitude: "52.0907", longitude: "5.1214" } });
    return json({
      data: {
        storesByCoordinates: {
          totalCount: 1,
          stores: [
            {
              storeId: "s1",
              name: "Jumbo Utrecht Centrum",
              distance: "1.25",
              location: { address: { street: "Oudegracht", houseNumber: "1", city: "Utrecht", postalCode: "3511" } },
              openingHours: { monday: { opensAt: "08:00", closesAt: "21:00" } },
              facilities: { locationType: "SUPERMARKT" },
            },
          ],
        },
      },
    });
  });
  const r = await new JumboClient().searchStores({ query: "utrecht" });
  assert.deepEqual(r.searched_location, { latitude: "52.0907", longitude: "5.1214" });
  assert.equal(r.total_found, 1);
  assert.equal(r.stores[0].distanceKm, 1.25);
  assert.equal(r.stores[0].address.city, "Utrecht");
  assert.equal(r.stores[0].locationType, "SUPERMARKT");
});

test("searchStores: malformed payload yields an empty store list", async () => {
  installFetch(() => json({ data: {} }));
  const r = await new JumboClient().searchStores({ latitude: 52.37, longitude: 4.9 });
  assert.deepEqual(r.stores, []);
  assert.equal(r.total_found, 0);
});

// ------------------------------------------------------- getProductRecommendations

test("getProductRecommendations: promotionsOnly flattens the promotion tab", async () => {
  installFetch(() =>
    json({
      data: {
        promotionTab: {
          runtimes: [
            {
              sections: [
                {
                  promotions: [
                    { products: [{ title: "Melk", sku: "S1", price: { price: 139, promoPrice: 99 } }] },
                    { products: [{ title: "Brood", sku: "S2", price: { price: 149, promoPrice: null } }] },
                  ],
                },
              ],
            },
          ],
        },
      },
    })
  );
  const r = await new JumboClient().getProductRecommendations({ promotionsOnly: true });
  assert.deepEqual(r.alternatives, []);
  assert.deepEqual(r.promotions?.map((p) => p.sku), ["S1", "S2"]);
});

test("getProductRecommendations: sku path returns source + alternatives + crossSells", async () => {
  installFetch(() =>
    json({
      data: {
        product: {
          title: "Melk",
          sku: "S1",
          price: { price: 139, promoPrice: 99 },
          alternatives: [{ title: "Halfvolle", sku: "S9", price: { price: 129, promoPrice: null } }],
          crossSells: [{ title: "Brood", sku: "S2", price: { price: 149, promoPrice: null } }],
        },
      },
    })
  );
  const r = await new JumboClient().getProductRecommendations({ sku: "S1" });
  assert.equal(r.sourceProduct?.sku, "S1");
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.crossSells?.length, 1);
});

test("getProductRecommendations: query with no hit returns an empty result", async () => {
  installFetch(() => json({ data: { searchProducts: { products: [] } } }));
  const r = await new JumboClient().getProductRecommendations({ query: "nothing" });
  assert.equal(r.sourceProduct, null);
  assert.deepEqual(r.alternatives, []);
  assert.deepEqual(r.crossSells, []);
});

// ------------------------------------------------------------------ searchProducts

test("searchProducts: maps prices to cents, formats them and prefixes links", async () => {
  installFetch((body) => {
    assert.deepEqual(body.variables, { input: { searchType: "KEYWORD", searchTerms: "melk", sort: "PRICE_ASC" } });
    return json({
      data: {
        searchProducts: {
          count: 2,
          products: [
            {
              title: "Halfvolle melk",
              sku: "S1",
              link: "/producten/melk",
              price: { price: 139, promoPrice: 99, pricePerUnit: { price: 139 } },
              availability: { isAvailable: true },
              promotions: [{ tags: [{ text: "2e halve prijs" }] }],
            },
            {
              title: "Volle melk",
              sku: "S2",
              link: "",
              price: { price: 145, promoPrice: null, pricePerUnit: { price: 145 } },
              availability: { isAvailable: false },
              promotions: [],
            },
          ],
        },
      },
    });
  });
  const r = await new JumboClient().searchProducts({ query: "melk", sort: "PRICE_ASC" });
  assert.equal(r.total_count, 2);
  assert.equal(r.products[0].price_formatted, "€1.39");
  assert.equal(r.products[0].promo_price_formatted, "€0.99");
  assert.equal(r.products[0].unit_price_formatted, "€1.39");
  assert.equal(r.products[0].url, "https://www.jumbo.com/producten/melk");
  assert.deepEqual(r.products[0].promotions, ["2e halve prijs"]);
  assert.equal(r.products[0].is_available, true);
  assert.equal(r.products[1].promo_price_formatted, null);
  assert.equal(r.products[1].url, "");
});

test("searchProducts: honours limit and tolerates a malformed payload", async () => {
  installFetch(() =>
    json({
      data: {
        searchProducts: {
          count: 5,
          products: Array.from({ length: 5 }, (_, i) => ({
            title: `P${i}`,
            sku: `S${i}`,
            link: "/x",
            price: { price: 100, promoPrice: null, pricePerUnit: { price: 100 } },
            availability: { isAvailable: true },
            promotions: [],
          })),
        },
      },
    })
  );
  const r = await new JumboClient().searchProducts({ query: "x", limit: 2 });
  assert.equal(r.products.length, 2);

  installFetch(() => json({ data: {} }));
  const empty = await new JumboClient().searchProducts({ query: "x" });
  assert.deepEqual(empty.products, []);
});

// ------------------------------------------------------------------ parseReceiptDoc

test("parseReceiptDoc: extracts items, total, payment method and VAT lines", () => {
  const c = new JumboClient();
  const parsed = c.parseReceiptDoc(
    receiptDoc([
      "OMSCHRIJVING",
      "Halfvolle melk 2,19",
      "Brood P 1,49",
      "Totaal 3,68",
      "PIN",
      "BTW overzicht",
      "9% 0,30",
      "Totaal 3,68",
    ])
  );
  assert.equal(parsed.total, 3.68);
  assert.equal(parsed.payment_method, "PIN");
  assert.deepEqual(parsed.items, [
    { name: "Halfvolle melk", price: 2.19, is_promotion: false },
    { name: "Brood", price: 1.49, is_promotion: true },
  ]);
  assert.deepEqual(parsed.vat_overview, ["9% 0,30"]);
  assert.ok(parsed.raw_lines.includes("OMSCHRIJVING"));
});

test("parseReceiptDoc: malformed input returns empty results, never throws", () => {
  const c = new JumboClient();
  for (const bad of ["not json", "", "{}", '{"documents":[]}']) {
    const parsed = c.parseReceiptDoc(bad);
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.total, null);
    assert.equal(parsed.payment_method, null);
  }
});
