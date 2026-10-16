import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import { TokensData, PkceSession } from "./types.js";

export const AUTH_CONFIG = {
  domain: "auth.jumbo.com",
  client_id: "JxF3wi1b7MOTd9qXutaxqd9uHt4KmG3U",
  audience: "https://jumbo.com/web",
  base_url: "https://www.jumbo.com",
} as const;

export const REDIRECT_URI = "jumbo://callbacks/login";

/**
 * Default OAuth scope. Mirrors the Jumbo web/app login (auth0-spa-js), which
 * sends `scope` on BOTH the authorization_code and refresh_token grants.
 */
export const DEFAULT_SCOPE = "openid profile email offline_access";

/**
 * Namespaced claim Jumbo's GraphQL router uses to resolve the signed-in
 * customer. Without it the API answers "Customer ID cannot be null or empty" /
 * "401 UNAUTHORIZED Customer ID header is required".
 */
export const CUSTOMER_ID_CLAIM = "https://jumbo.com/customerId";

/**
 * Raised when the stored Jumbo session cannot be used or renewed. `code` lets
 * callers distinguish "we never had a usable session" from "Jumbo rejected the
 * token we sent", instead of leaking raw upstream GraphQL text.
 */
export class JumboAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JumboAuthError";
    this.code = code;
  }
}

/**
 * Guard a freshly minted access token. A refresh that succeeds at Auth0 can
 * still return a token Jumbo will not accept (typically because the grant was
 * issued for the wrong `audience`), so fail loudly here rather than sending a
 * dead token upstream and reporting a raw GraphQL error later.
 */
export function assertUsableAccessToken(accessToken: string): void {
  // Opaque (non-JWT) tokens cannot be inspected; only validate JWTs.
  if (!accessToken || accessToken.split(".").length < 3) return;

  const claims = decodeJwtPayload(accessToken);
  if (!claims || Object.keys(claims).length === 0) return;

  const aud = claims.aud;
  const audList = Array.isArray(aud) ? aud : aud ? [aud] : [];
  if (audList.length > 0 && !audList.includes(AUTH_CONFIG.audience)) {
    throw new JumboAuthError(
      "INVALID_REFRESHED_TOKEN",
      `Refreshed Jumbo token has audience ${JSON.stringify(audList)} but this client ` +
        `requires '${AUTH_CONFIG.audience}'. Jumbo's customer identity is only attached ` +
        `to that audience. Re-run 'jumbo-mcp login', and set JUMBO_REFRESH_TOKEN from ` +
        `that login for headless deployments.`
    );
  }

  if (!claims[CUSTOMER_ID_CLAIM]) {
    throw new JumboAuthError(
      "INVALID_REFRESHED_TOKEN",
      `Refreshed Jumbo token has no '${CUSTOMER_ID_CLAIM}' claim, so Jumbo cannot ` +
        `resolve a customer (upstream then reports "Customer ID cannot be null or ` +
        `empty"). Re-run 'jumbo-mcp login' and set JUMBO_REFRESH_TOKEN from that ` +
        `login for headless deployments.`
    );
  }
}

export function getTokensFilePath(): string {
  const envPath = process.env.JUMBO_TOKENS_FILE;
  if (envPath) return path.resolve(envPath.replace(/^~/, os.homedir()));

  const primary = path.join(os.homedir(), ".config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(primary)) return primary;

  // Fallback to legacy path if present
  const legacy = path.join(os.homedir(), ".gemini", "config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(legacy)) return legacy;

  return primary;
}

export function getSessionFilePath(): string {
  const baseDir = path.dirname(getTokensFilePath());
  return path.join(baseDir, ".pkce_session.json");
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generateRandomString(length: number = 32): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.randomBytes(length);
  let res = "";
  for (let i = 0; i < length; i++) {
    res += alphabet[bytes[i] % alphabet.length];
  }
  return res;
}

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateRandomString(64);
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(hash);
  return { codeVerifier, codeChallenge };
}

export function decodeJwtPayload(jwtStr: string): Record<string, any> {
  try {
    const parts = jwtStr.split(".");
    if (parts.length < 2) return {};
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

export function loadTokens(): TokensData | null {
  const filePath = getTokensFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

export function saveTokens(tokens: TokensData): void {
  try {
    const filePath = getTokensFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore permissions failure on Windows
    }
  } catch {
    // Ignore if running in a read-only environment
  }
}

export function buildAuthorizeUrl(
  scope: string = "openid profile email offline_access"
): { url: string; session: PkceSession } {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateRandomString(32);
  const nonce = generateRandomString(32);

  const params = new URLSearchParams({
    client_id: AUTH_CONFIG.client_id,
    redirect_uri: REDIRECT_URI,
    audience: AUTH_CONFIG.audience,
    scope,
    response_type: "code",
    response_mode: "query",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    platform: "mobile",
    verifyEmail: "false",
    trigger_registration_flow: "BASIC_REGISTRATION",
    prompt: "login",
  });

  const url = `https://${AUTH_CONFIG.domain}/authorize?${params.toString()}`;
  const session: PkceSession = {
    domain: AUTH_CONFIG.domain,
    client_id: AUTH_CONFIG.client_id,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
    state,
    nonce,
    created_at: new Date().toISOString(),
  };

  const sessPath = getSessionFilePath();
  fs.mkdirSync(path.dirname(sessPath), { recursive: true });
  fs.writeFileSync(sessPath, JSON.stringify(session, null, 2), "utf-8");

  return { url, session };
}

export async function exchangeCode(
  codeOrUrl: string,
  state?: string,
  verifierOverride?: string
): Promise<TokensData> {
  let code = codeOrUrl.trim();
  if (code.startsWith("jumbo://") || code.includes("?")) {
    try {
      const parsed = new URL(code.replace(/^jumbo:\/\//, "https://dummy/"));
      const c = parsed.searchParams.get("code");
      const s = parsed.searchParams.get("state");
      if (c) code = c;
      if (s && !state) state = s;
    } catch {
      // Fallback
    }
  }

  let codeVerifier = verifierOverride;
  let domain: string = AUTH_CONFIG.domain;
  let clientId: string = AUTH_CONFIG.client_id;
  let redirectUri: string = REDIRECT_URI;

  const sessPath = getSessionFilePath();
  if (!codeVerifier && fs.existsSync(sessPath)) {
    try {
      const sess: PkceSession = JSON.parse(fs.readFileSync(sessPath, "utf-8"));
      codeVerifier = sess.code_verifier;
      domain = sess.domain;
      clientId = sess.client_id;
      redirectUri = sess.redirect_uri;
    } catch {
      // Ignore
    }
  }

  if (!codeVerifier) {
    throw new Error("No PKCE code_verifier found. Please initiate login first.");
  }

  const tokenUrl = `https://${domain}/oauth/token`;
  // Send `audience` + `scope` on the exchange too: auth0-spa-js does, and it
  // keeps the initial token's claims identical to the refreshed one.
  const payload = {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    audience: AUTH_CONFIG.audience,
    scope: DEFAULT_SCOPE,
  };

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Auth0 token exchange failed (${resp.status}): ${errText}`);
  }

  const tokens = (await resp.json()) as TokensData;
  tokens.saved_at = new Date().toISOString();
  tokens.domain = domain;
  tokens.client_id = clientId;

  saveTokens(tokens);

  if (fs.existsSync(sessPath)) {
    try {
      fs.unlinkSync(sessPath);
    } catch {
      // Ignore
    }
  }

  return tokens;
}

export async function refreshTokens(existing?: TokensData): Promise<TokensData> {
  const tokens = existing || loadTokens();
  const rToken = tokens?.refresh_token || process.env.JUMBO_REFRESH_TOKEN;

  if (!rToken) {
    throw new JumboAuthError(
      "MISSING_REFRESH_TOKEN",
      "No Jumbo refresh_token is available, so the session cannot be renewed. Run " +
        "'jumbo-mcp login' to re-authenticate, and set JUMBO_REFRESH_TOKEN from that " +
        "login for headless deployments."
    );
  }

  const domain = tokens?.domain || AUTH_CONFIG.domain;
  const clientId = tokens?.client_id || AUTH_CONFIG.client_id;
  const tokenUrl = `https://${domain}/oauth/token`;

  // `audience` and `scope` are REQUIRED here. Auth0 mints the refreshed access
  // token for the client's default audience when `audience` is omitted, and the
  // 'https://jumbo.com/customerId' claim is only attached to the Jumbo web API
  // audience -- so an audience-less refresh returns a token Jumbo rejects with
  // "Customer ID cannot be null or empty". (auth0-spa-js spreads the stored
  // authorization params, including audience + scope, into this grant.)
  const payload = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: rToken,
    audience: AUTH_CONFIG.audience,
    scope: DEFAULT_SCOPE,
  };

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Auth0 token refresh failed (${resp.status}): ${errText}`);
  }

  const fresh = (await resp.json()) as Partial<TokensData>;

  // Validate before persisting: never overwrite a good session with a token
  // Jumbo will reject.
  assertUsableAccessToken(fresh.access_token || "");

  const merged: TokensData = {
    ...(tokens || {}),
    ...fresh,
    access_token: fresh.access_token || tokens?.access_token || "",
    saved_at: new Date().toISOString(),
    domain,
    client_id: clientId,
  };

  saveTokens(merged);
  return merged;
}

export async function getValidAccessToken(
  opts: { ignoreEnvOverride?: boolean } = {}
): Promise<string | null> {
  // JUMBO_TOKEN is an explicit operator override. The retry path passes
  // `ignoreEnvOverride` so a mid-flight refresh is not undone by re-reading a
  // now-stale JUMBO_TOKEN.
  if (!opts.ignoreEnvOverride) {
    const tokenOverride = process.env.JUMBO_TOKEN;
    if (tokenOverride) return tokenOverride.trim();
  }

  const tokens = loadTokens();
  let accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token || process.env.JUMBO_REFRESH_TOKEN;

  if (!accessToken && !refreshToken) return null;

  let shouldRefresh = false;
  if (!accessToken) {
    shouldRefresh = true;
  } else if (tokens?.saved_at) {
    try {
      const savedAt = new Date(tokens.saved_at).getTime();
      const ageSec = (Date.now() - savedAt) / 1000;
      const expiresIn = tokens.expires_in || 86400;
      if (ageSec > expiresIn - 1800) {
        shouldRefresh = true;
      }
    } catch {
      // Ignore
    }
  }

  if (shouldRefresh && !refreshToken) {
    // Previously this path returned the stale token silently, which surfaced
    // later as an opaque upstream "Customer ID" error. Fail loudly instead.
    throw new JumboAuthError(
      "MISSING_REFRESH_TOKEN",
      `The stored Jumbo access token is expired and no refresh_token is available ` +
        `(checked ${getTokensFilePath()} and JUMBO_REFRESH_TOKEN). Run ` +
        `'jumbo-mcp login' to re-authenticate.`
    );
  }

  if (shouldRefresh && refreshToken) {
    // No catch: a refresh failure must surface as an actionable auth error
    // rather than degrading into "use the dead token and hope".
    const fresh = await refreshTokens(tokens || undefined);
    accessToken = fresh.access_token;
  }

  return accessToken || null;
}

function openInBrowser(url: string) {
  const platform = process.platform;
  if (platform === "darwin") {
    exec(`open "${url}"`);
  } else if (platform === "win32") {
    exec(`start "" "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

export async function loginCli(): Promise<void> {
  const { url } = buildAuthorizeUrl();

  console.log("\n" + "=".repeat(70));
  console.log("🚀 JUMBO MCP - AUTHENTICATION");
  console.log("=".repeat(70));
  console.log("\nOpening your browser to log in to Jumbo...");
  console.log(`\nIf the browser does not open automatically, visit this URL:\n\n${url}\n`);

  try {
    openInBrowser(url);
  } catch {
    // Ignore
  }

  console.log("=".repeat(70));
  console.log("INSTRUCTIONS:");
  console.log("1. Sign in to your Jumbo account in the browser.");
  console.log("2. When finished, the browser will attempt to redirect to:");
  console.log("   jumbo://callbacks/login?code=XXXX&state=YYYY");
  console.log("   (The browser might show 'Address invalid' or 'Cannot open' - that is normal!)");
  console.log("3. Copy the full address from your browser's address bar and paste it below.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let redirectInput = "";
  try {
    redirectInput = await rl.question("Paste redirect URL (or code): ");
  } finally {
    rl.close();
  }

  redirectInput = redirectInput.trim();
  if (!redirectInput) {
    console.log("No URL or code provided. Login aborted.");
    process.exit(1);
  }

  console.log("\n🔄 Exchanging code for permanent tokens...");
  try {
    const tokens = await exchangeCode(redirectInput);
    console.log("🎉 Successfully authenticated!");
    console.log(`📁 Tokens saved to: ${getTokensFilePath()}`);

    const claims = decodeJwtPayload(tokens.access_token);
    const custId = claims[CUSTOMER_ID_CLAIM];
    const email = claims["https://jumbo.com/username"];
    if (custId) console.log(`👤 Customer ID: ${custId}`);
    if (email) console.log(`📧 Account:     ${email}`);

    console.log("\nYou are all set! You can now use jumbo-mcp in your AI assistant.");
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }
}
