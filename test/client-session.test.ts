/**
 * Session-renewal behaviour of `JumboClient.executeGraphql`.
 *
 * No live Jumbo calls: `globalThis.fetch` is routed by URL so we can assert the
 * exact headers sent on the first attempt AND on the post-refresh replay.
 *
 * Regression focus (2026-10-16 outage): after a 200-with-GraphQL-errors
 * "Customer ID" response, the retry must use the freshly refreshed token --
 * including when JUMBO_TOKEN is set in the environment -- and a session that is
 * still rejected must fail with an actionable message, not raw upstream text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jumbo-session-test-"));
const tokensFile = path.join(tmpDir, "tokens.json");

process.env.JUMBO_TOKENS_FILE = tokensFile;
process.env.JUMBO_TOKEN = "stale-env-token";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient, JumboSessionInvalidError } = await import("../src/client.js");
const { AUTH_CONFIG, CUSTOMER_ID_CLAIM } = await import("../src/auth.js");

function b64url(o: any): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

const FRESH_TOKEN = `${b64url({ alg: "RS256" })}.${b64url({
  aud: [AUTH_CONFIG.audience],
  [CUSTOMER_ID_CLAIM]: "cust-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.sig`;

type Call = { url: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];

function seed(): void {
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      access_token: "stored-access-token",
      refresh_token: "rt-1",
      client_id: AUTH_CONFIG.client_id,
      domain: AUTH_CONFIG.domain,
      expires_in: 86400,
      saved_at: new Date().toISOString(),
    }),
    "utf-8"
  );
}

/**
 * Route by URL: the token endpoint always succeeds; GraphQL responses are
 * supplied by `graphqlResponses` in call order (last one repeats).
 */
function installFetch(graphqlResponses: any[]): void {
  calls = [];
  let gqlIndex = 0;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init?.headers || {}, body });
    if (url.includes("/oauth/token")) {
      return json({ access_token: FRESH_TOKEN, expires_in: 86400, refresh_token: "rt-2" });
    }
    const res = graphqlResponses[Math.min(gqlIndex, graphqlResponses.length - 1)];
    gqlIndex += 1;
    return json(res);
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

const graphqlCalls = () => calls.filter((c) => c.url.includes("/api/graphql"));
const refreshCalls = () => calls.filter((c) => c.url.includes("/oauth/token"));

test("a Customer ID error triggers one refresh, and the replay uses the NEW token", async () => {
  seed();
  installFetch([
    { errors: [{ message: "Customer ID cannot be null or empty" }] },
    { data: { getProfile: { customerId: "cust-1", name: { givenName: "Robert" } } } },
  ]);

  const client = new JumboClient();
  const data = await client.executeGraphql<any>("query GetProfile { getProfile { customerId } }");

  assert.equal(data.getProfile.customerId, "cust-1");
  assert.equal(refreshCalls().length, 1, "exactly one refresh");
  assert.equal(graphqlCalls().length, 2, "original attempt + one replay");

  assert.equal(
    graphqlCalls()[0].headers.Authorization,
    "Bearer stale-env-token",
    "first attempt uses the operator override"
  );
  assert.equal(
    graphqlCalls()[1].headers.Authorization,
    `Bearer ${FRESH_TOKEN}`,
    "replay must use the refreshed token, not the stale JUMBO_TOKEN"
  );

  assert.equal(
    refreshCalls()[0].body.audience,
    AUTH_CONFIG.audience,
    "the refresh itself must request the Jumbo audience"
  );
});

test("no customer-id style header is invented by the client", async () => {
  seed();
  installFetch([{ data: { getProfile: { customerId: "cust-1" } } }]);

  const client = new JumboClient();
  await client.executeGraphql<any>("query GetProfile { getProfile { customerId } }");

  const headerNames = Object.keys(graphqlCalls()[0].headers).map((h) => h.toLowerCase());
  assert.equal(
    headerNames.some((h) => h.includes("customer")),
    false,
    "Jumbo derives the customer from the bearer token; the app sends no customer-id header"
  );
});

test("a session that stays rejected fails actionably instead of leaking raw GraphQL text", async () => {
  seed();
  installFetch([{ errors: [{ message: "Customer ID cannot be null or empty" }] }]);

  const client = new JumboClient();
  await assert.rejects(
    () => client.executeGraphql<any>("query GetProfile { getProfile { customerId } }"),
    (err: any) =>
      err instanceof JumboSessionInvalidError &&
      /jumbo-mcp login/.test(err.message) &&
      !/^GraphQL Error:/.test(err.message)
  );

  assert.equal(graphqlCalls().length, 2, "one refresh + one retry, then give up");
  assert.equal(refreshCalls().length, 1);
});

test("a 401 UNAUTHORIZED GraphQL error is treated as a session failure too", async () => {
  seed();
  installFetch([
    { errors: [{ message: '401 UNAUTHORIZED "Customer ID header is required"' }] },
    { data: { getProfile: { customerId: "cust-1" } } },
  ]);

  const client = new JumboClient();
  const data = await client.executeGraphql<any>("query GetProfile { getProfile { customerId } }");
  assert.equal(data.getProfile.customerId, "cust-1");
  assert.equal(graphqlCalls()[1].headers.Authorization, `Bearer ${FRESH_TOKEN}`);
});

test("unrelated GraphQL errors are NOT rewritten as session errors", async () => {
  seed();
  installFetch([{ errors: [{ message: "Something else went wrong" }] }]);

  const client = new JumboClient();
  await assert.rejects(
    () => client.executeGraphql<any>("query GetProfile { getProfile { customerId } }"),
    (err: any) =>
      !(err instanceof JumboSessionInvalidError) &&
      err.message === "GraphQL Error: Something else went wrong"
  );
  assert.equal(refreshCalls().length, 0, "no pointless refresh for a non-auth error");
});
