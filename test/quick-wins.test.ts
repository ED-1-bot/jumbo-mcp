/**
 * Quick-wins tests: remove items, complete/un-complete, dedupe-on-add,
 * basket (read-only), deposits, stamps. Mocked HTTP only — no live Jumbo calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient, JumboApiError, JumboShoppingListError } = await import(
  "../src/client.js"
);

let calls: { url: string; method?: string; headers?: Record<string, string>; body: any }[] = [];

function installFetch(handler: (body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method, headers: init?.headers, body });
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
const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];
const opsSeen = () => calls.map((c) => op(c.body));

// --------------------------------------------------------------- remove items

test("remove items: sends { shoppingListItemIds } and returns the removed ids", async () => {
  installFetch((body) => {
    assert.deepEqual(body.variables, { input: { shoppingListItemIds: ["a", "b"] } });
    return json({
      data: {
        removeShoppingListItems: {
          __typename: "ShoppingListItemIdsResult",
          itemIds: ["a", "b"],
        },
      },
    });
  });
  const client = new JumboClient();
  assert.deepEqual(await client.removeShoppingListItems(["a", "b"]), ["a", "b"]);
});

test("remove items: surfaces ShoppingListError with reason/errorMessage", async () => {
  installFetch(() =>
    json({
      data: {
        removeShoppingListItems: {
          __typename: "ShoppingListError",
          reason: "ITEM_NOT_FOUND",
          errorMessage: "Unknown item id",
        },
      },
    })
  );
  const client = new JumboClient();
  await assert.rejects(() => client.removeShoppingListItems(["zz"]), (err: any) => {
    assert.ok(err instanceof JumboShoppingListError);
    assert.equal(err.reason, "ITEM_NOT_FOUND");
    assert.equal(err.errorMessage, "Unknown item id");
    return true;
  });
});

test("remove items: malformed/unexpected union member raises UNEXPECTED_RESULT", async () => {
  installFetch(() => json({ data: { removeShoppingListItems: { __typename: "WeirdShape" } } }));
  const client = new JumboClient();
  await assert.rejects(() => client.removeShoppingListItems(["a"]), (err: any) => {
    assert.equal(err.reason, "UNEXPECTED_RESULT");
    return true;
  });
});

test("remove items: rejects empty input before any HTTP call", async () => {
  installFetch(() => {
    throw new Error("fetch must not be called");
  });
  const client = new JumboClient();
  await assert.rejects(() => client.removeShoppingListItems([]));
  assert.equal(calls.length, 0);
});

// -------------------------------------------------------- complete / un-complete

test("complete: looks up the item and sends id + term + completed", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetShoppingList":
        return json({
          data: {
            shoppingList: {
              __typename: "ShoppingList",
              isActive: true,
              items: [
                { id: "7", term: "melk", sku: null, completed: false },
                { id: "8", term: "brood", sku: "BROOD01", completed: false },
              ],
            },
          },
        });
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "8", term: "brood", sku: "BROOD01", completed: true }],
            },
          },
        });
      default:
        throw new Error("unexpected " + op(body));
    }
  });
  const client = new JumboClient();
  const items = await client.setShoppingListItemCompleted("8", true);
  assert.equal(items[0].completed, true);

  const edit = calls.find((c) => op(c.body) === "EditShoppingListItems")!;
  assert.deepEqual(edit.body.variables, {
    input: { items: [{ id: "8", term: "brood", sku: "BROOD01", completed: true }] },
  });
});

test("complete: unknown id raises ITEM_NOT_FOUND without an edit call", async () => {
  installFetch((body) => {
    if (op(body) === "GetShoppingList") {
      return json({
        data: {
          shoppingList: { __typename: "ShoppingList", isActive: true, items: [] },
        },
      });
    }
    throw new Error("must not call " + op(body));
  });
  const client = new JumboClient();
  await assert.rejects(() => client.setShoppingListItemCompleted("nope", true), (err: any) => {
    assert.equal(err.reason, "ITEM_NOT_FOUND");
    return true;
  });
  assert.equal(opsSeen().includes("EditShoppingListItems"), false);
});

// ------------------------------------------------------------------- dedupe

test("dedupe: skips existing terms case-insensitively and reports them", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetShoppingList":
        return json({
          data: {
            shoppingList: {
              __typename: "ShoppingList",
              isActive: true,
              items: [
                { id: "1", term: "Eieren", sku: null, completed: false },
                { id: "2", term: "melk", sku: null, completed: false },
              ],
            },
          },
        });
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "3", term: "brood", sku: null, completed: false }],
            },
          },
        });
      default:
        throw new Error("unexpected " + op(body));
    }
  });
  const client = new JumboClient();
  const res = await client.addShoppingListItems(["eieren", "BROOD", "melk", "brood"]);

  assert.deepEqual(res.skipped, ["eieren", "melk", "brood"]); // existing + in-batch dup
  const edit = calls.find((c) => op(c.body) === "EditShoppingListItems")!;
  assert.deepEqual(edit.body.variables, {
    input: { items: [{ term: "BROOD", completed: false }] },
  });
});

test("dedupe:false preserves the original duplicate-allowed behaviour", async () => {
  installFetch((body) => {
    switch (op(body)) {
      case "GetShoppingList":
        return json({
          data: {
            shoppingList: {
              __typename: "ShoppingList",
              isActive: true,
              items: [{ id: "1", term: "eieren", sku: null, completed: false }],
            },
          },
        });
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "9", term: "eieren", sku: null, completed: false }],
            },
          },
        });
      default:
        throw new Error("unexpected " + op(body));
    }
  });
  const client = new JumboClient();
  const res = await client.addShoppingListItems(["eieren"], { dedupe: false });
  assert.deepEqual(res.skipped, []);
  const edit = calls.find((c) => op(c.body) === "EditShoppingListItems")!;
  assert.deepEqual(edit.body.variables, {
    input: { items: [{ term: "eieren", completed: false }] },
  });
});

test("dedupe: all terms already present makes no edit call", async () => {
  installFetch((body) => {
    if (op(body) === "GetShoppingList") {
      return json({
        data: {
          shoppingList: {
            __typename: "ShoppingList",
            isActive: true,
            items: [{ id: "1", term: "eieren", sku: null, completed: false }],
          },
        },
      });
    }
    throw new Error("must not call " + op(body));
  });
  const client = new JumboClient();
  const res = await client.addShoppingListItems(["eieren"]);
  assert.deepEqual(res.skipped, ["eieren"]);
  assert.deepEqual(res.added, []);
  assert.equal(opsSeen().includes("EditShoppingListItems"), false);
});

// -------------------------------------------------------------------- basket

test("basket: maps lines, promotions, line totals and subtotal; sends no unused variables", async () => {
  installFetch((body) => {
    // Jumbo rejects declared-but-unused variables with GRAPHQL_VALIDATION_FAILED.
    // The app's Apollo Client strips them before sending; so must we.
    assert.equal(
      body.variables,
      undefined,
      "no variables are sent for a query that declares none"
    );
    assert.equal(
      /\$\w+\s*:/.test(body.query),
      false,
      "ActiveBasket declares no variables, so none can be unused"
    );
    return json({
      data: {
        activeBasket: {
          __typename: "ActiveBasketResult",
          basket: {
            id: "bk1",
            totalProductCount: 3,
            lines: [
              {
                sku: "SKU1",
                id: "l1",
                quantity: 2,
                details: {
                  title: "Halfvolle melk",
                  price: { price: 139, promoPrice: 99 },
                  promotions: [{ tags: [{ text: "2e halve prijs" }] }],
                },
              },
            ],
            calculation: {
              totals: {
                itemSubtotal: { amount: 198, currency: "EUR" },
                totalToPay: { amount: 198, currency: "EUR" },
              },
            },
          },
        },
      },
    });
  });
  const client = new JumboClient();
  const b = await client.getBasket();
  assert.equal(b.subtotal, 198);
  assert.equal(b.total_to_pay, 198);
  assert.equal(b.currency, "EUR");
  assert.equal(b.lines[0].unit_price, 139);
  assert.equal(b.lines[0].promo_price, 99);
  assert.equal(b.lines[0].line_total, 198); // promo 99 * 2
  assert.deepEqual(b.lines[0].promotions, ["2e halve prijs"]);
});

test("basket: BasketError union is raised, not returned as an empty basket", async () => {
  installFetch(() =>
    json({
      data: {
        activeBasket: {
          __typename: "BasketError",
          reason: "NO_BASKET",
          errorMessage: "No active basket",
        },
      },
    })
  );
  const client = new JumboClient();
  await assert.rejects(() => client.getBasket(), (err: any) => {
    assert.ok(err instanceof JumboApiError);
    assert.equal(err.typename, "BasketError");
    assert.equal(err.reason, "NO_BASKET");
    return true;
  });
});

test("basket: malformed response raises UNEXPECTED_RESULT", async () => {
  installFetch(() => json({ data: { activeBasket: {} } }));
  const client = new JumboClient();
  await assert.rejects(() => client.getBasket(), (err: any) => {
    assert.equal(err.reason, "UNEXPECTED_RESULT");
    return true;
  });
});

// ------------------------------------------------------------------ deposits

test("deposits: maps catalogue + returned deposits for the order", async () => {
  installFetch((body) => {
    assert.deepEqual(body.variables, { orderId: "ord-1" });
    return json({
      data: {
        deposits: [
          {
            sku: "DEP1",
            description: "PET fles",
            category: "PLASTIC",
            chargeType: "STATIEGELD",
            unitPrice: { amount: 15, currency: "EUR" },
          },
        ],
        returnedDeposits: {
          __typename: "ReturnedDepositsResponseSuccess",
          returnedDeposits: [
            { sku: "DEP1", price: { amount: 15, currency: "EUR" }, returnedByCustomerQuantity: 4 },
          ],
          returnedDepositsTotalAmount: { amount: 60, currency: "EUR" },
        },
      },
    });
  });
  const client = new JumboClient();
  const d = await client.getDeposits("ord-1");
  assert.equal(d.deposits[0].unit_price, 15);
  assert.equal(d.returned.items[0].returned_quantity, 4);
  assert.equal(d.returned.total, 60);
  assert.equal(d.returned.currency, "EUR");
});

test("deposits: error union member is raised (fields unknown -> typename surfaced)", async () => {
  installFetch(() =>
    json({
      data: {
        deposits: [],
        returnedDeposits: { __typename: "ReturnedDepositsError" },
      },
    })
  );
  const client = new JumboClient();
  await assert.rejects(() => client.getDeposits("ord-1"), (err: any) => {
    assert.ok(err instanceof JumboApiError);
    assert.equal(err.typename, "ReturnedDepositsError");
    return true;
  });
});

test("deposits: requires an order id", async () => {
  installFetch(() => {
    throw new Error("fetch must not be called");
  });
  const client = new JumboClient();
  await assert.rejects(() => client.getDeposits("  "));
  assert.equal(calls.length, 0);
});

// -------------------------------------------------------------------- stamps

test("stamps: maps digital stamps, saving campaigns and buying balance", async () => {
  installFetch((body) => {
    assert.match(body.query, /query GetStamps/);
    return json({
      data: {
        getDigitalStamps: { digitalStamps: [{ campaignId: "c1", numberStamps: 3 }] },
        getCampaigns: [
          {
            active: true,
            id: "c1",
            title: "Pannen",
            campaignCode: "PAN",
            campaignData: {
              numberOfStampsPerCard: 12,
              stampsNeededForRedemption: { stamps: 12, subTitle: "volle kaart" },
              stampType: "SAVING",
            },
          },
        ],
        getBuyingStampsBalance: {
          monetaryValue: 250,
          amountOfStamps: 5,
          amountOfStampsPerCard: 100,
        },
      },
    });
  });
  const client = new JumboClient();
  const s = await client.getStamps();
  assert.equal(s.digital_stamps[0].campaign_id, "c1");
  assert.equal(s.digital_stamps[0].number_stamps, 3);
  assert.equal(s.saving_campaigns[0].title, "Pannen");
  assert.equal(s.saving_campaigns[0].stamps_needed_for_redemption, 12);
  assert.equal(s.buying_stamps?.amount_of_stamps, 5);
});

test("stamps: malformed/empty response degrades to empty collections, never throws", async () => {
  installFetch(() => json({ data: {} }));
  const client = new JumboClient();
  const s = await client.getStamps();
  assert.deepEqual(s.digital_stamps, []);
  assert.deepEqual(s.saving_campaigns, []);
  assert.equal(s.buying_stamps, null);
});
