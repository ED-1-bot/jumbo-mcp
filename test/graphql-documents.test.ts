/**
 * GraphQL document hygiene.
 *
 * Guards the bug class behind the 2026-10-16 basket failure: `ActiveBasket`
 * declared `$orderChannel` but never used it, so Jumbo rejected the request with
 * HTTP 400 / GRAPHQL_VALIDATION_FAILED ("Variable \"$orderChannel\" is never
 * used."). Apollo Client strips unused variables before sending; we must not
 * declare them at all.
 *
 * This parses the source statically, so it covers every document in the client
 * (not just the ones a test happens to exercise) and needs no HTTP mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, "..", "src", "client.ts"), "utf-8");

/** Every backtick string in client.ts that is a GraphQL operation. */
function graphqlDocuments(src: string): string[] {
  const out: string[] = [];
  const re = /`([\s\S]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/\b(query|mutation)\s+\w+/.test(m[1])) out.push(m[1]);
  }
  return out;
}

function operationName(doc: string): string {
  const m = /(?:query|mutation)\s+(\w+)/.exec(doc);
  return m ? m[1] : "(unknown)";
}

/** Variable names declared in the operation's argument list. */
function declaredVariables(doc: string): string[] {
  const m = /(?:query|mutation)\s+\w+\s*(\(([^)]*)\))?/.exec(doc);
  const decl = m?.[2] ?? "";
  return [...decl.matchAll(/\$(\w+)\s*:/g)].map((x) => x[1]);
}

test("no GraphQL document declares a variable it does not use", () => {
  const docs = graphqlDocuments(clientSource);
  assert.ok(docs.length >= 15, `expected the client's documents, found ${docs.length}`);

  const offenders: string[] = [];
  for (const doc of docs) {
    const body = doc.replace(/(?:query|mutation)\s+\w+\s*(\(([^)]*)\))?/, "");
    const unused = declaredVariables(doc).filter(
      (v) => !new RegExp(`\\$${v}\\b`).test(body)
    );
    if (unused.length > 0) {
      offenders.push(`${operationName(doc)}: unused $${unused.join(", $")}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Jumbo rejects these with GRAPHQL_VALIDATION_FAILED: " + offenders.join("; ")
  );
});

test("documents are actually found by the scanner (sanity)", () => {
  const names = graphqlDocuments(clientSource).map(operationName);
  for (const expected of [
    "ActiveBasket",
    "GetProfile",
    "GetReceiptOverview",
    "GetShoppingList",
    "EditShoppingListItems",
    "GetDeposits",
    "GetStamps",
  ]) {
    assert.ok(names.includes(expected), `${expected} should be present in client.ts`);
  }
  assert.ok(
    names.includes("ActiveBasket"),
    "the previously-broken query must stay covered by the guard"
  );
});
