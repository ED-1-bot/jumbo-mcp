import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import * as https from "node:https";
import { fileURLToPath } from "node:url";
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

export function getProjectDir(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, "..");
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  } catch {
    // Ignore
  }
  return process.cwd();
}

/**
 * Env var naming the tokens file. Named here because every actionable error
 * about token persistence has to point the operator at it.
 */
export const TOKENS_FILE_ENV_VAR = "JUMBO_TOKENS_FILE";

export function getTokensFilePath(): string {
  const envPath = process.env[TOKENS_FILE_ENV_VAR];
  if (envPath) return path.resolve(envPath.replace(/^~/, os.homedir()));

  // 1. Primary: tokens.json in project root
  const projectFile = path.join(getProjectDir(), "tokens.json");
  if (fs.existsSync(projectFile)) return projectFile;

  // 2. Working directory tokens.json
  const cwdFile = path.resolve(process.cwd(), "tokens.json");
  if (fs.existsSync(cwdFile)) return cwdFile;

  // 3. Fallback to container data dir (/data/tokens.json) if it exists
  const containerData = "/data/tokens.json";
  if (fs.existsSync(containerData)) return containerData;

  // 4. Fallback to global config (~/.config/jumbo-mcp/tokens.json) if it exists
  const globalConfig = path.join(os.homedir(), ".config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(globalConfig)) return globalConfig;

  // 5. Fallback to legacy path if present
  const legacy = path.join(os.homedir(), ".gemini", "config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(legacy)) return legacy;

  return projectFile;
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
    } catch (error: any) {
      console.error(
        `[jumbo-mcp] WARNING: tokens file exists at ${filePath} but could not be read/parsed ` +
          `(${error?.message || error}). Ignoring corrupted tokens file.`
      );
      return null;
    }
  }
  return null;
}

/**
 * Preflight that the tokens file can be written before contacting Auth0.
 *
 * If the path or volume is unwritable, failing before `POST /oauth/token` keeps
 * the existing refresh token alive upstream. If we refresh first and fail to
 * persist the rotated token, the token family is permanently lost on restart.
 */
export function assertTokensPathWritable(): void {
  const filePath = getTokensFilePath();
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(
      fs.existsSync(filePath) ? filePath : dir,
      fs.constants.W_OK
    );
  } catch (error: any) {
    const reason = error?.message || error?.code || String(error);
    throw new JumboAuthError(
      "TOKENS_NOT_PERSISTED",
      `Could not verify that the Jumbo tokens can be persisted to ${filePath} before refresh (${reason}). ` +
        `Auth0 rotates the refresh token on every refresh; refreshing now would consume the live token ` +
        `without saving the replacement. Fix the cause above and set ${TOKENS_FILE_ENV_VAR} to a writable ` +
        `file on persistent storage (for a container: mount a volume and use ${TOKENS_FILE_ENV_VAR}=/data/tokens.json).`
    );
  }
}

/**
 * Persist the session. A failure here is never ignorable: Auth0 rotates the
 * refresh token on every refresh, so a token that only exists in memory is
 * lost at the next restart -- the process then re-reads the previous token,
 * Auth0's reuse detection invalidates the entire family, and every tool call
 * fails with `invalid_grant`. Fail loudly with the resolved path and the fix.
 *
 * Writes are performed atomically (write to temp file then rename) to prevent
 * partial or corrupt writes if the process is terminated mid-flight.
 */
export function saveTokens(tokens: TokensData): void {
  const filePath = getTokensFilePath();
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.tokens.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(tokens, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } catch (error: any) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore temp file cleanup error
    }
    // Node's fs errors already lead with their code ("EACCES: permission denied, mkdir …").
    const reason = error?.message || error?.code || String(error);
    throw new JumboAuthError(
      "TOKENS_NOT_PERSISTED",
      `Could not persist the Jumbo tokens to ${filePath} (${reason}). Auth0 rotates the refresh ` +
        `token on every refresh, so the rotated token was not persisted and is unavailable to ` +
        `subsequent refresh attempts. If the previous token is replayed, Auth0's reuse detection ` +
        `invalidates the whole token family, and every call fails with invalid_grant. Fix the cause ` +
        `above and set ${TOKENS_FILE_ENV_VAR} to a writable file on persistent storage (for a container: ` +
        `mount a volume and use ${TOKENS_FILE_ENV_VAR}=/data/tokens.json).`
    );
  }

  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error: any) {
    // The token is durable at this point, so this is a confidentiality problem,
    // not a persistence one -- warn loudly instead of failing a good refresh.
    console.error(
      `[jumbo-mcp] WARNING: tokens were written to ${filePath} but chmod 600 failed ` +
        `(${error?.code || error?.message || error}). The refresh token may be readable by other ` +
        `accounts on this host; restrict the file's permissions or point ${TOKENS_FILE_ENV_VAR} at ` +
        `a private path.`
    );
  }
}

/**
 * Refresh-token precedence, in one place: a refresh token stored on disk always
 * wins over `JUMBO_REFRESH_TOKEN`. Rotation is enabled on Jumbo's Auth0 tenant,
 * so after the first refresh the file holds the only live token; replaying the
 * env value would hand Auth0 an already-used token and kill the family. The env
 * var is a bootstrap value only -- read when no stored token exists at all.
 */
export function resolveRefreshToken(tokens: TokensData | null): {
  token: string | null;
  source: "file" | "env" | null;
} {
  const stored = tokens?.refresh_token?.trim();
  if (stored) return { token: stored, source: "file" };

  const fromEnv = process.env.JUMBO_REFRESH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  return { token: null, source: null };
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

/**
 * Resilient fetch for Auth0 token requests. Tries native fetch first, but if
 * that fails (e.g. EBADF in Node 26 on Darwin during child process cleanup),
 * falls back to node:https, and finally to system curl to guarantee success.
 */
async function authFetch(
  urlStr: string,
  options: { method: string; headers: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  let lastErr: any = null;

  // 1. Try global fetch (with quick retry on transient socket errors, except EBADF)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(urlStr, options);
    } catch (err: any) {
      lastErr = err;
      const isEbadf =
        err?.message?.includes("EBADF") ||
        err?.cause?.code === "EBADF" ||
        err?.cause?.message?.includes("EBADF");
      if (isEbadf) break; // Don't retry broken socket in undici, switch to fallbacks immediately
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  // 2. Try node:https with isolated agent (keepAlive disabled)
  try {
    return await new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const postData = options.body || "";
      const reqHeaders = {
        ...options.headers,
        "Content-Length": String(Buffer.byteLength(postData)),
      };

      const agent = new https.Agent({ keepAlive: false });
      const req = https.request(
        parsed,
        {
          method: options.method || "POST",
          headers: reqHeaders,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            resolve({
              ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
              status: res.statusCode || 0,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        }
      );
      req.on("error", (e) => reject(e));
      req.write(postData);
      req.end();
    });
  } catch (httpsErr: any) {
    lastErr = httpsErr;
  }

  // 3. Fallback to system curl (runs in isolated process, immune to parent libuv descriptor issues)
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      const delimiter = "---HTTP_STATUS---";
      const args = [
        "-s",
        "-S",
        "-X",
        options.method || "POST",
        "-w",
        `${delimiter}%{http_code}`,
        urlStr,
      ];
      for (const [k, v] of Object.entries(options.headers || {})) {
        args.push("-H", `${k}: ${v}`);
      }
      if (options.body) {
        args.push("-d", options.body);
      }
      execFile("curl", args, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`curl failed: ${err.message} (${stderr})`));
        }
        const idx = stdout.lastIndexOf(delimiter);
        const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
        const statusStr = idx >= 0 ? stdout.slice(idx + delimiter.length).trim() : "0";
        const statusCode = parseInt(statusStr, 10) || 0;
        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
  } catch (curlErr: any) {
    throw lastErr || curlErr;
  }
}

export async function exchangeCode(
  codeOrUrl: string,
  state?: string,
  verifierOverride?: string,
  opts: { save?: boolean } = {}
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

  const resp = await authFetch(tokenUrl, {
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

  if (opts.save) {
    saveTokens(tokens);
  }

  if (fs.existsSync(sessPath)) {
    try {
      fs.unlinkSync(sessPath);
    } catch {
      // Ignore
    }
  }

  return tokens;
}

/**
 * Turn an Auth0 rejection into an operator diagnosis. A rotated-away refresh
 * token is a permanent condition (reuse detection has already invalidated the
 * family), so the message must say that no retry can help and name the exact
 * remediation: re-login, new env bootstrap value, and a persistent tokens file.
 */
function describeRefreshFailure(status: number, errText: string): Error {
  let error: string | undefined;
  let description: string | undefined;
  try {
    const parsed = JSON.parse(errText);
    if (typeof parsed?.error === "string") error = parsed.error;
    if (typeof parsed?.error_description === "string") description = parsed.error_description;
  } catch {
    // Non-JSON body: the raw text is all we have.
  }

  if (error === "invalid_grant" || /invalid_grant|Unknown or invalid refresh token/i.test(errText)) {
    const detail = (description || errText).replace(/[\s.]+$/, "");
    return new JumboAuthError(
      "REFRESH_TOKEN_REJECTED",
      `Auth0 token refresh failed (${status}, invalid_grant): ${detail}. The stored Jumbo refresh ` +
        `token is dead: Jumbo's Auth0 tenant rotates refresh tokens and detects reuse, so once a ` +
        `rotated token is not persisted (or the env token is replayed after a restart) the whole ` +
        `token family is invalidated and no retry can recover it. Tokens path: ` +
        `${getTokensFilePath()}. Operator action: run 'jumbo-mcp login' again, set ` +
        `JUMBO_REFRESH_TOKEN from that login (bootstrap value only), and for a container set ` +
        `${TOKENS_FILE_ENV_VAR} to a writable path on a persistent volume ` +
        `(for example ${TOKENS_FILE_ENV_VAR}=/data/tokens.json) so the rotated token survives a restart.`
    );
  }

  return new JumboAuthError(
    "REFRESH_FAILED",
    `Auth0 token refresh failed (${status}): ${errText} (tokens path: ${getTokensFilePath()})`
  );
}

export async function refreshTokens(existing?: TokensData): Promise<TokensData> {
  const tokens = existing || loadTokens();
  const { token: rToken } = resolveRefreshToken(tokens);

  if (!rToken) {
    throw new JumboAuthError(
      "MISSING_REFRESH_TOKEN",
      `No Jumbo refresh_token is available (nothing usable in ${getTokensFilePath()} and no ` +
        `JUMBO_REFRESH_TOKEN is set), so the session cannot be renewed. Run 'jumbo-mcp login' ` +
        `to re-authenticate; for a container, persist the tokens file on a mounted volume via ` +
        `${TOKENS_FILE_ENV_VAR} instead of relying on the env bootstrap value alone.`
    );
  }

  assertTokensPathWritable();

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

  const resp = await authFetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw describeRefreshFailure(resp.status, errText);
  }

  const fresh = (await resp.json()) as Partial<TokensData>;

  // Validate before persisting: never overwrite a good session with a token
  // Jumbo will reject.
  assertUsableAccessToken(fresh.access_token || "");

  const merged: TokensData = {
    ...(tokens || {}),
    ...fresh,
    refresh_token: fresh.refresh_token || rToken || tokens?.refresh_token,
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
    if (tokenOverride && tokenOverride.trim() && tokenOverride.trim() !== "<UNKNOWN>") {
      return tokenOverride.trim();
    }
  }

  const tokens = loadTokens();
  let accessToken = tokens?.access_token;
  const { token: refreshToken } = resolveRefreshToken(tokens);

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

let stealthConfigured = false;

export async function loginWithBrowser(
  url: string
): Promise<{ redirectUrl: string; close: () => Promise<void> } | null> {
  let chromium: any;
  try {
    const pwe = await import("playwright-extra");
    const stealthMod = await import("puppeteer-extra-plugin-stealth");
    const stealth = (stealthMod as any).default || stealthMod;
    chromium = pwe.chromium;
    if (!stealthConfigured) {
      chromium.use(stealth());
      stealthConfigured = true;
    }
  } catch {
    try {
      const pw = await import("playwright");
      chromium = pw.chromium;
    } catch {
      return null;
    }
  }

  const profileDir = path.join(os.homedir(), ".config", "jumbo-mcp", "browser_profile");
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    // Ignore
  }

  const isHeadless = process.env.JUMBO_HEADLESS === "true" || process.env.CI === "true";

  const launchOptions = {
    headless: isHeadless,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-sandbox",
    ],
    viewport: { width: 1280, height: 800 },
  };

  let context: any = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        ...launchOptions,
      });
    } catch {
      context = await chromium.launchPersistentContext(profileDir, launchOptions);
    }

    const page = context.pages()[0] || (await context.newPage());

    console.log("\n🌐 Opening Jumbo login in Chrome...");
    console.log("👉 Please sign in to your Jumbo account in the browser window.");
    console.log("   (Your redirect callback will be captured automatically — no copy/paste needed!)\n");

    return await new Promise<{ redirectUrl: string; close: () => Promise<void> } | null>((resolve) => {
      let resolved = false;

      const closeHandler = async () => {
        try {
          await context?.close();
        } catch {
          // Ignore
        }
      };

      const handleUrl = (targetUrl: string) => {
        if (
          !resolved &&
          (targetUrl.startsWith("jumbo://callbacks/login") ||
            targetUrl.startsWith("jumbo://callbacks/mfa"))
        ) {
          resolved = true;
          console.log("⚡ Captured OAuth redirect callback automatically!");
          // Keep browser alive until exchangeCode finishes so process cleanup does not cause EBADF
          resolve({ redirectUrl: targetUrl, close: closeHandler });
        }
      };

      page.on("request", (req: any) => handleUrl(req.url()));
      page.on("requestfailed", (req: any) => handleUrl(req.url()));
      page.on("framenavigated", (frame: any) => {
        if (frame === page.mainFrame()) {
          handleUrl(frame.url());
        }
      });

      page.on("close", () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      context.on("close", () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      page.goto(url).catch(() => {
        // Navigating to custom scheme might throw in page.goto, which is expected
      });
    });
  } catch (err: any) {
    if (context) {
      try {
        await context.close();
      } catch {
        // Ignore
      }
    }
    return null;
  }
}

export async function loginCli(opts: { manual?: boolean; save?: boolean } = {}): Promise<void> {
  const { url } = buildAuthorizeUrl();

  console.log("\n" + "=".repeat(70));
  console.log("🚀 JUMBO MCP - AUTHENTICATION");
  console.log("=".repeat(70));

  let redirectInput = "";
  let browserSession: { redirectUrl: string; close: () => Promise<void> } | null = null;

  if (!opts.manual) {
    try {
      browserSession = await loginWithBrowser(url);
      if (browserSession) {
        redirectInput = browserSession.redirectUrl;
      }
    } catch {
      // Fallback
    }
  }

  if (!redirectInput) {
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

    try {
      redirectInput = await rl.question("Paste redirect URL (or code): ");
    } finally {
      rl.close();
    }
  }

  redirectInput = redirectInput.trim();
  if (!redirectInput) {
    if (browserSession) await browserSession.close();
    console.log("No URL or code provided. Login aborted.");
    process.exit(1);
  }

  // Close browser before exchanging tokens so OS pipes and child processes are cleanly reaped
  if (browserSession) {
    try {
      await browserSession.close();
      browserSession = null;
    } catch {
      // Ignore
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n🔄 Exchanging code for permanent tokens...");
  try {
    const tokens = await exchangeCode(redirectInput, undefined, undefined, { save: opts.save });
    console.log("\n" + "=".repeat(70));
    console.log("🎉 SUCCESSFULLY AUTHENTICATED!");
    console.log("=".repeat(70));

    const claims = decodeJwtPayload(tokens.access_token);
    const custId = claims[CUSTOMER_ID_CLAIM];
    const email = claims["https://jumbo.com/username"];
    if (custId) console.log(`👤 Customer ID: ${custId}`);
    if (email) console.log(`📧 Account:     ${email}`);

    if (tokens.refresh_token) {
      console.log(`\nJUMBO_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }

    if (opts.save) {
      console.log(`📁 Tokens saved to: ${getTokensFilePath()}`);
    }

    console.log("You are all set! You can now use jumbo-mcp in your AI assistant.");
  } catch (err: any) {
    const causeMsg = (err as any)?.cause
      ? ` (cause: ${(err as any).cause?.message || (err as any).cause?.code || (err as any).cause})`
      : "";
    console.error(`❌ Login failed: ${err.message}${causeMsg}`);
    process.exit(1);
  } finally {
    if (browserSession) {
      await browserSession.close();
    }
  }
}
