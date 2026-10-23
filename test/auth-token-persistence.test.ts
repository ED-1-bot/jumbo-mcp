/**
 * Token-persistence tests.
 *
 * Regression focus (2026-10-24 outage): Jumbo's Auth0 tenant rotates refresh
 * tokens and detects reuse. A deployment whose tokens file was not on a
 * persistent volume silently wrote the rotated token into an ephemeral layer,
 * fell back to the stale JUMBO_REFRESH_TOKEN after a restart, and Auth0 then
 * invalidated the whole family -- every tool call answered
 * `403 invalid_grant "Unknown or invalid refresh token."`.
 *
 * Covered here: the rotated token must land on disk, the on-disk token must beat
 * a differing env value on every path, and an unwritable path must fail loudly
 * instead of continuing in memory.
 *
 * No live Auth0 calls: `globalThis.fetch` is replaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jumbo-auth-persist-"));
const tokensFile = path.join(tmpDir, "tokens.json");
const unwritableFile = "/nonexistent/jumbo-mcp/tokens.json";

process.env.JUMBO_TOKENS_FILE = tokensFile;
delete process.env.JUMBO_TOKEN;
delete process.env.JUMBO_REFRESH_TOKEN;

const {
  AUTH_CONFIG,
  CUSTOMER_ID_CLAIM,
  JumboAuthError,
  getTokensFilePath,
  loadTokens,
  refreshTokens,
  getValidAccessToken,
  resolveRefreshToken,
  saveTokens,
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

const GOOD_TOKEN = jwt({
  aud: [AUTH_CONFIG.audience],
  [CUSTOMER_ID_CLAIM]: "cust-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function seed(overrides: Record<string, any> = {}): void {
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      access_token: GOOD_TOKEN,
      refresh_token: "rt-file",
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

test("the rotated refresh token is persisted to the resolved tokens file", async () => {
  seed({ refresh_token: "rt-1" });
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-2" }));

  await refreshTokens();

  assert.equal(calls[0].body.refresh_token, "rt-1");
  assert.equal(stored().refresh_token, "rt-2", "the rotated token must survive a restart");
  assert.equal(loadTokens()?.refresh_token, "rt-2");

  if (process.platform !== "win32") {
    assert.equal(
      fs.statSync(tokensFile).mode & 0o777,
      0o600,
      "the tokens file holds a refresh token and must stay private"
    );
  }
});

test("a stored refresh token wins over a differing JUMBO_REFRESH_TOKEN", async () => {
  seed({ refresh_token: "rt-file" });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.deepEqual(resolveRefreshToken(loadTokens()), {
      token: "rt-file",
      source: "file",
    });

    await refreshTokens();
    assert.equal(
      calls[0].body.refresh_token,
      "rt-file",
      "replaying the env token would hand Auth0 an already-rotated token"
    );
    assert.equal(stored().refresh_token, "rt-rotated");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("getValidAccessToken renews with the stored token, not the env value", async () => {
  seed({
    access_token: "expired-token",
    refresh_token: "rt-file",
    saved_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    expires_in: 3600,
  });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.equal(await getValidAccessToken(), GOOD_TOKEN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.refresh_token, "rt-file");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("the env token is still the bootstrap value when no tokens file exists", async () => {
  fs.rmSync(tokensFile, { force: true });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-from-env" }));

  try {
    assert.deepEqual(resolveRefreshToken(null), { token: "rt-env", source: "env" });

    await refreshTokens();
    assert.equal(calls[0].body.refresh_token, "rt-env");
    assert.equal(stored().refresh_token, "rt-from-env", "the bootstrap result is persisted for rotation");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("an unwritable tokens path fails loudly instead of continuing in memory", async () => {
  fs.rmSync(tokensFile, { force: true });
  const previous = process.env.JUMBO_TOKENS_FILE;
  process.env.JUMBO_TOKENS_FILE = unwritableFile;
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.equal(getTokensFilePath(), unwritableFile);

    await assert.rejects(
      () => refreshTokens(),
      (err: any) =>
        err instanceof JumboAuthError &&
        err.code === "TOKENS_NOT_PERSISTED" &&
        err.message.includes(unwritableFile) &&
        err.message.includes("JUMBO_TOKENS_FILE")
    );
    assert.equal(fs.existsSync(unwritableFile), false);
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
    process.env.JUMBO_TOKENS_FILE = previous;
  }
});

test("saveTokens reports the failed write with the resolved path", () => {
  const previous = process.env.JUMBO_TOKENS_FILE;
  process.env.JUMBO_TOKENS_FILE = unwritableFile;

  try {
    assert.throws(
      () => saveTokens({ access_token: "a", refresh_token: "rt", domain: AUTH_CONFIG.domain }),
      (err: any) =>
        err instanceof JumboAuthError &&
        err.code === "TOKENS_NOT_PERSISTED" &&
        err.message.includes(unwritableFile) &&
        /invalid_grant/.test(err.message) &&
        /JUMBO_TOKENS_FILE/.test(err.message)
    );
  } finally {
    process.env.JUMBO_TOKENS_FILE = previous;
  }
});

test("invalid_grant names the operator action and the tokens path", async () => {
  seed({ refresh_token: "rt-dead" });
  installFetch(() =>
    json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403)
  );

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "REFRESH_TOKEN_REJECTED" &&
      /invalid_grant/.test(err.message) &&
      /Unknown or invalid refresh token/.test(err.message) &&
      /jumbo-mcp login/.test(err.message) &&
      err.message.includes(tokensFile) &&
      /JUMBO_TOKENS_FILE/.test(err.message) &&
      /persistent volume/.test(err.message)
  );

  assert.equal(stored().refresh_token, "rt-dead", "a rejected refresh must not rewrite the session");
});

test("a transient refresh failure is reported without the rotation diagnosis", async () => {
  seed({ refresh_token: "rt-1" });
  installFetch(() => json({ error: "server_error" }, 500));

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "REFRESH_FAILED" &&
      /token refresh failed/.test(err.message) &&
      !/invalid_grant/.test(err.message)
  );
});
