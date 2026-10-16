import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.JUMBO_HEADLESS = "true";

import { loginWithBrowser } from "../src/auth.js";

test("loginWithBrowser captures custom scheme redirect and extracts URL", async () => {
  const dummyCode = "test-auth-code-123";
  const dummyState = "test-state-456";
  const targetCallback = `jumbo://callbacks/login?code=${dummyCode}&state=${dummyState}`;

  const server = http.createServer((req, res) => {
    if (req.url === "/login") {
      res.writeHead(302, { Location: targetCallback });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><a id=\"link\" href=\"/login\">Sign in</a><script>window.location.href='/login';</script></body></html>");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const startUrl = `http://localhost:${port}`;

  try {
    const result = await loginWithBrowser(startUrl);
    assert.equal(result?.redirectUrl, targetCallback);
    await result?.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("exchangeCode falls back cleanly when fetch throws EBADF", async () => {
  const { exchangeCode } = await import("../src/auth.js");
  const origFetch = globalThis.fetch;
  const ebadfErr = new Error("fetch failed");
  (ebadfErr as any).cause = { code: "EBADF", message: "read EBADF" };
  globalThis.fetch = () => Promise.reject(ebadfErr);

  try {
    await exchangeCode("jumbo://callbacks/login?code=dummy&state=dummy", undefined, "dummy_verifier");
    assert.fail("Should have reached Auth0 and rejected invalid code");
  } catch (err: any) {
    // Verified that it bypassed the broken fetch and reached Auth0
    assert.match(err.message, /Auth0 token exchange failed/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

