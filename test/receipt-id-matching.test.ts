/**
 * Receipt id-matching (2026-10-16 `jumbo_get_receipt_details` bug).
 *
 * `receiptOverview` -- what `listReceipts` reads -- hands back the receipt's
 * storage key (`<opaque>-<uuid>.json`), and that key is what the app threads
 * through `/bonnetjes/:digitalReceiptId`. The detail endpoint resolves on one of
 * the canonical segments of that key rather than the whole key, with no mapping
 * endpoint to ask which one. Previously `getReceiptDetails` sent the single form
 * it was handed and hard-failed with "Receipt not found", which silently killed
 * `jumbo_get_receipt_details`, `jumbo_search_receipts` and the receipt half of
 * `jumbo_get_promo_digest` (distinct_terms dropped to 0).
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

const RECEIPT_PAYLOAD = {
  receiptImage: {
    image: receiptDoc(["OMSCHRIJVING", "Halfvolle melk 2,19", "Totaal 2,19"]),
    type: "json",
    receiptPoints: { earned: 5, newBalance: 15, oldBalance: 10, redeemed: 0 },
  },
  store: { name: "Jumbo Test" },
  purchaseEndOn: "2026-10-01T10:00:00.000Z",
  receiptSource: "DIGITAL",
  customerDetails: { customerId: "c1", loyaltyCard: { number: "123" } },
};

const STORAGE_KEY = "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000.json";

// ---------------------------------------------------------------------------
// receiptIdCandidates
// ---------------------------------------------------------------------------

test("receiptIdCandidates: expands a storage key into every id form it can denote", () => {
  assert.deepEqual(JumboClient.receiptIdCandidates(STORAGE_KEY), [
    STORAGE_KEY,
    "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000",
    "752e67d6-bdb8-11f1-909c-ac190a7f0000",
    "23mg1yp18x",
  ]);
});

test("receiptIdCandidates: a suffix-less key yields three forms, not four", () => {
  const id = "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000";
  assert.deepEqual(JumboClient.receiptIdCandidates(id), [
    id,
    "752e67d6-bdb8-11f1-909c-ac190a7f0000",
    "23mg1yp18x",
  ]);
});

test("receiptIdCandidates: a bare opaque id is tried as-is, with no phantom forms", () => {
  assert.deepEqual(JumboClient.receiptIdCandidates("23mg1yp18x"), ["23mg1yp18x"]);
});

test("receiptIdCandidates: dedupes and never emits blank entries", () => {
  assert.deepEqual(JumboClient.receiptIdCandidates("   "), []);
  // "abc.json" stems to "abc", which must not be emitted twice.
  assert.deepEqual(JumboClient.receiptIdCandidates("abc.json"), ["abc.json", "abc"]);
  // A bare UUID stems to itself -- only one entry, no duplicate.
  const uuid = "752e67d6-bdb8-11f1-909c-ac190a7f0000";
  assert.deepEqual(JumboClient.receiptIdCandidates(uuid), [uuid]);
});

test("receiptIdCandidates: is not fooled by dots or underscores inside the opaque prefix", () => {
  // The prefix is opaque: it may contain '.', '_' and other non-alphanumerics,
  // so the split must key off the trailing UUID, not off [A-Za-z0-9]+.
  assert.deepEqual(
    JumboClient.receiptIdCandidates("a.b_c-752e67d6-bdb8-11f1-909c-ac190a7f0000.json"),
    [
      "a.b_c-752e67d6-bdb8-11f1-909c-ac190a7f0000.json",
      "a.b_c-752e67d6-bdb8-11f1-909c-ac190a7f0000",
      "752e67d6-bdb8-11f1-909c-ac190a7f0000",
      "a.b_c",
    ]
  );
});

test("receiptIdCandidates: a storage key made only of a UUID yields no duplicate forms", () => {
  const uuid = "752e67d6-bdb8-11f1-909c-ac190a7f0000";
  assert.deepEqual(JumboClient.receiptIdCandidates(uuid), [uuid]);
});

// ---------------------------------------------------------------------------
// getReceiptDetails: fall through the id forms
// ---------------------------------------------------------------------------

test("getReceiptDetails: resolves when only a canonical id form matches, and keeps the caller's id", async () => {
  installFetch((body) => {
    if (op(body) !== "GetDigitalReceipt") throw new Error("unexpected op " + op(body));
    // The whole storage key is unknown to the detail endpoint; the suffix-less
    // form is the one it resolves on.
    const sent = body?.variables?.transactionId;
    if (sent === STORAGE_KEY) return json({ data: { receipt: null } });
    if (sent === "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000") {
      return json({ data: { receipt: RECEIPT_PAYLOAD } });
    }
    return json({ data: { receipt: null } });
  });

  const client = new JumboClient();
  const details = await client.getReceiptDetails(STORAGE_KEY);

  // Round-trip preserved: the caller can keep passing jumbo_list_receipts' id.
  assert.equal(details.transaction_id, STORAGE_KEY);
  assert.equal(details.store, "Jumbo Test");
  assert.equal(details.points_earned, 5);
  assert.equal(details.items_count, 1);

  const sent = calls
    .filter((c) => c.op === "GetDigitalReceipt")
    .map((c) => c.body?.variables?.transactionId);
  assert.deepEqual(sent, [
    STORAGE_KEY,
    "23mg1yp18x-752e67d6-bdb8-11f1-909c-ac190a7f0000",
  ]);
});

test("getReceiptDetails: stops at the first hit and does not keep probing", async () => {
  installFetch((body) => {
    if (op(body) !== "GetDigitalReceipt") throw new Error("unexpected op " + op(body));
    return json({ data: { receipt: RECEIPT_PAYLOAD } });
  });

  const client = new JumboClient();
  await client.getReceiptDetails(STORAGE_KEY);
  assert.equal(calls.filter((c) => c.op === "GetDigitalReceipt").length, 1);
});

test("getReceiptDetails: a bare opaque prefix resolves without probing the other forms", async () => {
  installFetch((body) => {
    if (op(body) !== "GetDigitalReceipt") throw new Error("unexpected op " + op(body));
    const sent = body?.variables?.transactionId;
    return json({
      data: { receipt: sent === "23mg1yp18x" ? RECEIPT_PAYLOAD : null },
    });
  });

  const client = new JumboClient();
  const details = await client.getReceiptDetails("23mg1yp18x");
  assert.equal(details.items_count, 1);
  assert.deepEqual(
    calls.map((c) => c.body?.variables?.transactionId),
    ["23mg1yp18x"]
  );
});

test("getReceiptDetails: exhausts every form, then reports what it tried", async () => {
  installFetch((body) => {
    if (op(body) !== "GetDigitalReceipt") throw new Error("unexpected op " + op(body));
    return json({ data: { receipt: null } });
  });

  const client = new JumboClient();
  await assert.rejects(
    () => client.getReceiptDetails(STORAGE_KEY),
    (err: Error) => {
      assert.match(err.message, /Receipt not found for transactionId/);
      assert.match(err.message, /tried 4 id form\(s\)/);
      // Every form is named so a live failure is diagnosable from the message.
      for (const form of JumboClient.receiptIdCandidates(STORAGE_KEY)) {
        assert.ok(err.message.includes(form), `message should name ${form}`);
      }
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.op === "GetDigitalReceipt").length, 4);
});

test("getReceiptDetails: a hard failure is not swallowed by the fallback loop", async () => {
  let n = 0;
  installFetch((body) => {
    if (op(body) !== "GetDigitalReceipt") throw new Error("unexpected op " + op(body));
    n++;
    if (n === 1) return json({ data: { receipt: null } });
    // A real transport/GraphQL failure must propagate, not look like "no such id".
    return json({ errors: [{ message: "boom" }] }, 200);
  });

  const client = new JumboClient();
  await assert.rejects(
    () => client.getReceiptDetails(STORAGE_KEY),
    /GraphQL Error: boom/
  );
});
