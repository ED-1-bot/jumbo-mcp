/**
 * Auth / token-renewal tests.
 *
 * No live Auth0 calls: `globalThis.fetch` is replaced so every assertion is made
 * against the exact wire payload the client sends to /oauth/token.
 *
 * Regression focus: the refresh_token grant MUST carry `audience` (see the
 * 2026-10-16 outage -- an audience-less refresh yields a token Jumbo rejects
 * with "Customer ID cannot be null or empty").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jumbo-auth-test-"));
const tokensFile = path.join(tmpDir, "tokens.json");

process.env.JUMBO_TOKENS_FILE = tokensFile;
delete process.env.JUMBO_TOKEN;
delete process.env.JUMBO_REFRESH_TOKEN;

const {
  AUTH_CONFIG,
  CUSTOMER_ID_CLAIM,
  DEFAULT_SCOPE,
  JumboAuthError,
  refreshTokens,
  getValidAccessToken,
} = await import("../src/auth.js");

type Call = { url: string; body: any };
let calls: Call[] = [];

function installFetch(handler: (url: string, body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return handler(url, body);
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

function b64url(o: any): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

function jwt(claims: Record<string, any>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

const EXP = Math.floor(Date.now() / 1000) + 3600;

const GOOD_TOKEN = jwt({ aud: [AUTH_CONFIG.audience], [CUSTOMER_ID_CLAIM]: "cust-1", exp: EXP });
const NO_CLAIM_TOKEN = jwt({ aud: [AUTH_CONFIG.audience], exp: EXP });
const WRONG_AUD_TOKEN = jwt({ aud: ["https://example.test/other"], exp: EXP });
const OPAQUE_TOKEN = "not-a-jwt";

function seed(overrides: Record<string, any> = {}): void {
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      access_token: "old-access-token",
      refresh_token: "rt-1",
      client_id: AUTH_CONFIG.client_id,
      domain: AUTH_CONFIG.domain,
      expires_in: 86400,
      saved_at: new Date().toISOString(),
      ...overrides,
    }),
    "utf-8"
  );
}

function stored(): any {
  return JSON.parse(fs.readFileSync(tokensFile, "utf-8"));
}

test("refresh_token grant sends audience, scope, client_id and the refresh token", async () => {
  seed();
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-2" }));

  const fresh = await refreshTokens();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/oauth\/token$/);
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.equal(
    calls[0].body.audience,
    AUTH_CONFIG.audience,
    "audience is required or Auth0 mints a token for the wrong API"
  );
  assert.equal(calls[0].body.scope, DEFAULT_SCOPE);
  assert.equal(calls[0].body.client_id, AUTH_CONFIG.client_id);
  assert.equal(calls[0].body.refresh_token, "rt-1");

  assert.equal(fresh.access_token, GOOD_TOKEN);
  assert.equal(stored().access_token, GOOD_TOKEN);
  assert.equal(stored().refresh_token, "rt-2", "rotated refresh token is persisted");
});

test("refresh without a refresh_token fails loudly with an actionable code", async () => {
  seed({ refresh_token: undefined });
  installFetch(() => json({ access_token: GOOD_TOKEN }));

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "MISSING_REFRESH_TOKEN" &&
      /jumbo-mcp login/.test(err.message)
  );
  assert.equal(calls.length, 0, "no request is made without a refresh token");
});

test("a refreshed token without the customerId claim is rejected before it is persisted", async () => {
  seed();
  installFetch(() => json({ access_token: NO_CLAIM_TOKEN, expires_in: 86400 }));

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "INVALID_REFRESHED_TOKEN" &&
      err.message.includes(CUSTOMER_ID_CLAIM)
  );

  assert.equal(stored().access_token, "old-access-token", "good session is not overwritten");
});

test("a refreshed token for the wrong audience is rejected", async () => {
  seed();
  installFetch(() => json({ access_token: WRONG_AUD_TOKEN, expires_in: 86400 }));

  await assert.rejects(
    () => refreshTokens(),
    (err: any) => err instanceof JumboAuthError && err.code === "INVALID_REFRESHED_TOKEN"
  );
});

test("opaque (non-JWT) refreshed tokens are passed through unchecked", async () => {
  seed();
  installFetch(() => json({ access_token: OPAQUE_TOKEN, expires_in: 86400 }));

  const fresh = await refreshTokens();
  assert.equal(fresh.access_token, OPAQUE_TOKEN);
  assert.equal(stored().access_token, OPAQUE_TOKEN);
});

test("getValidAccessToken returns an unexpired stored token untouched", async () => {
  seed({ access_token: "live-token", saved_at: new Date().toISOString(), expires_in: 86400 });
  installFetch(() => json({}));

  assert.equal(await getValidAccessToken(), "live-token");
  assert.equal(calls.length, 0);
});

test("getValidAccessToken fails loudly when the token is expired and no refresh token exists", async () => {
  seed({
    access_token: "expired-token",
    refresh_token: undefined,
    saved_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    expires_in: 3600,
  });
  installFetch(() => json({}));

  await assert.rejects(
    () => getValidAccessToken(),
    (err: any) => err instanceof JumboAuthError && err.code === "MISSING_REFRESH_TOKEN"
  );
});

test("getValidAccessToken honours JUMBO_TOKEN unless explicitly ignored", async () => {
  seed({ access_token: "stored-token", saved_at: new Date().toISOString(), expires_in: 86400 });
  installFetch(() => json({}));
  process.env.JUMBO_TOKEN = "env-token";
  try {
    assert.equal(await getValidAccessToken(), "env-token");
    assert.equal(
      await getValidAccessToken({ ignoreEnvOverride: true }),
      "stored-token",
      "the retry path must be able to bypass a stale JUMBO_TOKEN"
    );
  } finally {
    delete process.env.JUMBO_TOKEN;
  }
});

test("getValidAccessToken surfaces a failed refresh instead of returning a dead token", async () => {
  seed({
    access_token: "expired-token",
    saved_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    expires_in: 3600,
  });
  installFetch(() => json({ error: "invalid_grant" }, 403));

  await assert.rejects(() => getValidAccessToken(), /token refresh failed/);
});
