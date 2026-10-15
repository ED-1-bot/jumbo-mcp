/**
 * Shopping-list write tests.
 *
 * No live Jumbo calls: `globalThis.fetch` is replaced with a router that keys on
 * the GraphQL operation name, so every assertion is made against the exact wire
 * payload the client sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Force the token path away from the real on-disk token store.
process.env.JUMBO_TOKEN = "test-access-token";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient, JumboShoppingListError } = await import("../src/client.js");

type Call = { url: string; method?: string; headers?: Record<string, string>; body: any };
let calls: Call[] = [];

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

function opName(body: any): string {
  const m = /(?:query|mutation)\s+(\w+)/.exec(body?.query || "");
  return m ? m[1] : "";
}

const opOf = (i: number) => opName(calls[i].body);

test("writes EditShoppingListItems with the exact term/completed payload", async () => {
  installFetch((body) => {
    switch (opName(body)) {
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "1", term: "eieren", sku: null, completed: false }],
            },
          },
        });
      case "GetShoppingList":
        return json({
          data: {
            shoppingList: {
              __typename: "ShoppingList",
              isActive: true,
              items: [],
            },
          },
        });
      default:
        throw new Error("unexpected operation " + opName(body));
    }
  });

  const client = new JumboClient();
  const res = await client.addShoppingListItems(["  eieren  "], { ensureActive: false });

  assert.equal(res.isActive, true);
  assert.equal(res.activated, false);
  assert.equal(res.added.length, 1);
  assert.equal(res.added[0].term, "eieren");
  assert.equal(res.added[0].completed, false);

  // payload check against the first (edit) call
  const editCall = calls.find((c) => opName(c.body) === "EditShoppingListItems")!;
  assert.deepEqual(editCall.body.variables, {
    input: { items: [{ term: "eieren", completed: false }] },
  });
  assert.equal(editCall.body.variables.input.items[0].id, undefined);
  assert.match(editCall.body.query, /mutation EditShoppingListItems/);
  assert.equal(editCall.body.query.includes("ShoppingListError"), true);
});

test("auto-activates an inactive list before adding", async () => {
  let toggled = false;
  installFetch((body) => {
    switch (opName(body)) {
      case "GetShoppingList":
        return json({
          data: {
            shoppingList: {
              __typename: "ShoppingList",
              isActive: toggled,
              items: toggled
                ? [{ id: "9", term: "melk", sku: null, completed: false }]
                : [],
            },
          },
        });
      case "toggleShoppingList":
        toggled = true;
        return json({
          data: {
            toggleShoppingList: { __typename: "ShoppingListState", isActive: true },
          },
        });
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "9", term: "melk", sku: null, completed: false }],
            },
          },
        });
      default:
        throw new Error("unexpected operation " + opName(body));
    }
  });

  const client = new JumboClient();
  const res = await client.addShoppingListItems(["melk"]);

  assert.equal(res.activated, true, "should have activated the list first");
  assert.equal(res.isActive, true);
  assert.equal(res.added[0].term, "melk");

  const toggleCall = calls.find((c) => opName(c.body) === "toggleShoppingList")!;
  assert.deepEqual(toggleCall.body.variables, { input: { active: true } });

  // ordering: read -> toggle -> edit -> read
  assert.deepEqual(calls.map((c) => opName(c.body)), [
    "GetShoppingList",
    "toggleShoppingList",
    "EditShoppingListItems",
    "GetShoppingList",
  ]);
});

test("skips activation when ensure_active is false", async () => {
  installFetch((body) => {
    switch (opName(body)) {
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "3", term: "brood", sku: null, completed: false }],
            },
          },
        });
      case "GetShoppingList":
        return json({
          data: { shoppingList: { __typename: "ShoppingList", isActive: false, items: [] } },
        });
      default:
        throw new Error("unexpected operation " + opName(body));
    }
  });

  const client = new JumboClient();
  const res = await client.addShoppingListItems(["brood"], { ensureActive: false });

  assert.equal(res.activated, false);
  assert.equal(res.isActive, false);
  assert.equal(calls.some((c) => opName(c.body) === "toggleShoppingList"), false);
});

test("surfaces ShoppingListError reason + errorMessage (never a silent success)", async () => {
  installFetch((body) => {
    switch (opName(body)) {
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "ShoppingListError",
              reason: "LIST_INACTIVE",
              errorMessage: "Shopping list is not active",
            },
          },
        });
      case "GetShoppingList":
        return json({
          data: { shoppingList: { __typename: "ShoppingList", isActive: true, items: [] } },
        });
      default:
        throw new Error("unexpected operation " + opName(body));
    }
  });

  const client = new JumboClient();
  await assert.rejects(
    () => client.addShoppingListItems(["eieren"], { ensureActive: false }),
    (err: any) => {
      assert.ok(err instanceof JumboShoppingListError, "should be a JumboShoppingListError");
      assert.equal(err.reason, "LIST_INACTIVE");
      assert.equal(err.errorMessage, "Shopping list is not active");
      assert.match(err.message, /LIST_INACTIVE/);
      return true;
    }
  );
});

test("getShoppingList surfaces ShoppingListError from the union", async () => {
  installFetch(() =>
    json({
      data: {
        shoppingList: {
          __typename: "ShoppingListError",
          reason: "NOT_AUTHENTICATED",
          errorMessage: "No active customer session",
        },
      },
    })
  );

  const client = new JumboClient();
  await assert.rejects(() => client.getShoppingList(), (err: any) => {
    assert.equal(err.reason, "NOT_AUTHENTICATED");
    assert.equal(err.errorMessage, "No active customer session");
    return true;
  });
});

test("setShoppingListActive returns the API's isActive", async () => {
  installFetch((body) => {
    assert.deepEqual(body.variables, { input: { active: false } });
    return json({
      data: { toggleShoppingList: { __typename: "ShoppingListState", isActive: false } },
    });
  });

  const client = new JumboClient();
  const isActive = await client.setShoppingListActive(false);
  assert.equal(isActive, false);
});

test("unexpected union member raises UNEXPECTED_RESULT", async () => {
  installFetch(() =>
    json({ data: { editShoppingListItems: { __typename: "SomethingElse" } } })
  );

  const client = new JumboClient();
  await assert.rejects(() => client.editShoppingListItems({ items: [{ term: "x" }] }), (err: any) => {
    assert.equal(err.reason, "UNEXPECTED_RESULT");
    return true;
  });
});

test("rejects an empty item list before any HTTP call", async () => {
  installFetch(() => {
    throw new Error("fetch must not be called");
  });

  const client = new JumboClient();
  await assert.rejects(() => client.editShoppingListItems({ items: [] }));
  await assert.rejects(() => client.addShoppingListItems(["   "]));
  assert.equal(calls.length, 0);
});

test("does not leak the access token into error text", async () => {
  installFetch(() => json({ message: "upstream boom" }, 500));

  const client = new JumboClient();
  await assert.rejects(() => client.getShoppingList(), (err: any) => {
    assert.equal(/test-access-token/.test(String(err.message)), false);
    return true;
  });

  // the bearer header is still sent, but never surfaced
  assert.match(calls[0].headers.Authorization, /^Bearer /);
});
