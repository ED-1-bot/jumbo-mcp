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
  assert.deepEqual(d.items[0], { name: "Halfvolle melk", price: 2.19, is_promotion: false, quantity: 1, unit_price: 2.19 });
  assert.deepEqual(d.items[1], { name: "Brood", price: 1.49, is_promotion: true, quantity: 1, unit_price: 1.49 });
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
    assert.deepEqual(body.variables, {
      input: { searchType: "KEYWORD", searchTerms: "melk", sort: "PRICE_ASC", limit: 25 },
    });
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

test("searchProducts: sends the limit to Jumbo and caps it at 200", async () => {
  const sent: number[] = [];
  installFetch((body) => {
    sent.push(body.variables.input.limit);
    return json({ data: { searchProducts: { count: 342, products: [] } } });
  });

  await new JumboClient().searchProducts({ query: "melk", limit: 120 });
  await new JumboClient().searchProducts({ query: "melk", limit: 5000 });

  assert.deepEqual(sent, [120, 200], "limit must reach Jumbo, clamped to the server window");
});

test("searchProducts: flags a result set that the 200-product window cannot hold", async () => {
  const page = Array.from({ length: 200 }, (_, i) => ({
    title: `P${i}`,
    sku: `S${i}`,
    link: "/x",
    price: { price: 100, promoPrice: null, pricePerUnit: { price: 100 } },
    availability: { isAvailable: true },
    promotions: [],
  }));
  installFetch(() => json({ data: { searchProducts: { count: 342, products: page } } }));

  const r = await new JumboClient().searchProducts({ query: "melk", limit: 200 });

  assert.equal(r.total_count, 342);
  assert.equal(r.products.length, 200);
  assert.equal(r.truncated, true);
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
    { name: "Halfvolle melk", price: 2.19, is_promotion: false, quantity: 1, unit_price: 2.19 },
    { name: "Brood", price: 1.49, is_promotion: true, quantity: 1, unit_price: 1.49 },
  ]);
  assert.deepEqual(parsed.vat_overview, ["9% 0,30"]);
  assert.ok(parsed.raw_lines.includes("OMSCHRIJVING"));
});

test("parseReceiptDoc: multi-line items with quantity multiplier, unit price and discount", () => {
  const c = new JumboClient();
  const parsed = c.parseReceiptDoc(
    receiptDoc([
      "OMSCHRIJVING                 BEDRAG IN EUR",
      "==========================================",
      "S MICHAEL RIESLING",
      "  2 X 4,99                            9,98",
      "ACTIE WIJNEN WIT                     -2,50",
      "COURGETTE",
      "  2 X 0,95                            1,90",
      "KOMKOMMER                P            0,95",
      "Totaal                               11,33",
    ])
  );
  assert.equal(parsed.total, 11.33);
  assert.deepEqual(parsed.items, [
    { name: "S MICHAEL RIESLING", price: 9.98, is_promotion: false, quantity: 2, unit_price: 4.99 },
    { name: "ACTIE WIJNEN WIT", price: -2.50, is_promotion: false, quantity: 1, unit_price: -2.50 },
    { name: "COURGETTE", price: 1.90, is_promotion: false, quantity: 2, unit_price: 0.95 },
    { name: "KOMKOMMER", price: 0.95, is_promotion: true, quantity: 1, unit_price: 0.95 },
  ]);
});

test("parseReceiptDoc: returned bottle deposit (Ret emballage gekoppeld) and card payment amount", () => {
  const c = new JumboClient();
  const parsed = c.parseReceiptDoc(
    receiptDoc([
      "OMSCHRIJVING                 BEDRAG IN EUR",
      "==========================================",
      "JUMBOS PS ARRABIATA                   2,99",
      "HALFVOLLE MELK 1.0 L                  1,29",
      "EXTRA JAM AARDBEI                     0,55",
      "CITROENEN                             0,71",
      "UIEN                                  0,49",
      "KANEELBROODJE                         0,59",
      "RUSTIEK ROZIJN WIT                    0,79",
      "Totaal                                7,41",
      "Betaald:                    ",
      "Ret emballage gekoppeld               2,55",
      "VISA                                  4,86",
    ])
  );
  assert.equal(parsed.total, 7.41);
  assert.equal(parsed.amount_paid, 4.86);
  assert.equal(parsed.returned_deposit, 2.55);
  assert.equal(parsed.charged_deposit, null);
  assert.equal(parsed.payment_method, "VISA");
  assert.equal(parsed.items.length, 7);
});

test("parseReceiptDoc: charged bottle deposit (STATIEGELD) and auto amount_paid without emballage", () => {
  const c = new JumboClient();
  const parsed = c.parseReceiptDoc(
    receiptDoc([
      "OMSCHRIJVING                 BEDRAG IN EUR",
      "==========================================",
      "SHOT GEMBER AARDBEI                   1,09",
      "STATIEGELD                            0,15",
      "SHOT ORANGE SHINE                     1,00",
      "STATIEGELD                            0,15",
      "Totaal                                2,39",
      "Betaald:                    ",
      "VISA                                  2,39",
    ])
  );
  assert.equal(parsed.total, 2.39);
  assert.equal(parsed.amount_paid, 2.39);
  assert.equal(parsed.returned_deposit, null);
  assert.equal(parsed.charged_deposit, 0.30);
  assert.equal(parsed.payment_method, "VISA");
});

test("parseReceiptDoc: malformed input returns empty results, never throws", () => {
  const c = new JumboClient();
  for (const bad of ["not json", "", "{}", '{"documents":[]}']) {
    const parsed = c.parseReceiptDoc(bad);
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.total, null);
    assert.equal(parsed.amount_paid, null);
    assert.equal(parsed.returned_deposit, null);
    assert.equal(parsed.charged_deposit, null);
    assert.equal(parsed.total_discount, null);
    assert.equal(parsed.subtotal, null);
    assert.equal(parsed.payment_method, null);
    assert.deepEqual(parsed.vat_breakdown, []);
  }
});

test("parseReceiptDoc: structured vat_breakdown, total_discount and subtotal", () => {
  const c = new JumboClient();
  const parsed = c.parseReceiptDoc(
    receiptDoc([
      "OMSCHRIJVING                 BEDRAG IN EUR",
      "==========================================",
      "JUMBO TROSTOMATEN                     2,49",
      "ACTIE TROSTOMATEN                    -1,00",
      "Totaal                                1,49",
      "Betaald:                    ",
      "VISA                                  1,49",
      "Totaal korting:                      -1,00",
      "BTW overzicht",
      "BTW%          Bedrag excl     BTW bedrag",
      "     9,00%           1,37           0,12",
      "BTW Totaal           1,37           0,12",
    ])
  );
  assert.equal(parsed.total, 1.49);
  assert.equal(parsed.subtotal, 2.49);
  assert.equal(parsed.total_discount, 1.00);
  assert.deepEqual(parsed.vat_breakdown, [
    { rate_percent: 9, amount_excl: 1.37, vat_amount: 0.12, amount_incl: 1.49 },
  ]);
});

test("getStatiegeldSummary: aggregates deposits over period and calculates net balance", async () => {
  installFetch((body) => {
    if (body.query.includes("GetReceiptOverview")) {
      return json({
        data: {
          receiptOverview: {
            totalResults: 2,
            pageSize: 25,
            currentPage: 0,
            receipts: [
              {
                transactionId: "r1.json",
                purchaseEndOn: "2026-10-18 14:00:00",
                receiptSource: "DIGITAL",
                store: { storeId: "3427", name: "Jumbo A" },
                pointBalance: 0,
              },
              {
                transactionId: "r2.json",
                purchaseEndOn: "2026-08-19 12:00:00",
                receiptSource: "DIGITAL",
                store: { storeId: "3427", name: "Jumbo A" },
                pointBalance: 0,
              },
            ],
          },
        },
      });
    }
    if (body.query.includes("GetDigitalReceipt")) {
      const id = body.variables.transactionId;
      if (id.includes("r1")) {
        return json({
          data: {
            receipt: {
              receiptImage: {
                image: receiptDoc([
                  "OMSCHRIJVING",
                  "Melk 1,50",
                  "Totaal 1,50",
                  "Betaald:",
                  "Ret emballage gekoppeld 2,50",
                  "VISA 0,00",
                ]),
              },
              store: { storeId: "3427", name: "Jumbo A" },
              purchaseEndOn: "2026-10-18 14:00:00",
            },
          },
        });
      } else {
        return json({
          data: {
            receipt: {
              receiptImage: {
                image: receiptDoc([
                  "OMSCHRIJVING",
                  "Sap 2,00",
                  "STATIEGELD 0,15",
                  "Totaal 2,15",
                  "Betaald:",
                  "VISA 2,15",
                ]),
              },
              store: { storeId: "3427", name: "Jumbo A" },
              purchaseEndOn: "2026-08-19 12:00:00",
            },
          },
        });
      }
    }
    return json({ data: {} });
  });

  const client = new JumboClient();
  const summary = await client.getStatiegeldSummary({ year: 2026 });
  assert.equal(summary.receipts_scanned, 2);
  assert.equal(summary.total_returned, 2.50);
  assert.equal(summary.total_charged, 0.15);
  assert.equal(summary.net_returned, 2.35);
  assert.equal(summary.trips_with_returned_deposit, 1);
  assert.equal(summary.trips_with_charged_deposit, 1);
  assert.equal(summary.receipts.length, 2);
});


