import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { exec } from "node:child_process";
import { TokensData, PkceSession } from "./types.js";

export const ENV_CONFIGS = {
  prod: {
    domain: "auth.jumbo.com",
    client_id: "JxF3wi1b7MOTd9qXutaxqd9uHt4KmG3U",
    audience: "https://jumbo.com/web",
    base_url: "https://www.jumbo.com",
  },
  test: {
    domain: "auth.test.jumbo.com",
    client_id: "JKlcUL4EXlDQ73U6jtVidKTQpzP6ucKk",
    audience: "https://jumbo.com/web",
    base_url: "https://test.jumbo.com",
  },
  acc: {
    domain: "auth.acc.jumbo.com",
    client_id: "ZPS3vKQfP43xgvN0k8Ve2dyIvdUMMqg4",
    audience: "https://jumbo.com/web",
    base_url: "https://acc-ish.jumbo.com",
  },
} as const;

export const REDIRECT_URI = "jumbo://callbacks/login";

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
  const filePath = getTokensFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore permissions failure on Windows
  }
}

export function buildAuthorizeUrl(
  env: keyof typeof ENV_CONFIGS = "prod",
  scope: string = "openid profile email offline_access"
): { url: string; session: PkceSession } {
  const cfg = ENV_CONFIGS[env];
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateRandomString(32);
  const nonce = generateRandomString(32);

  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: REDIRECT_URI,
    audience: cfg.audience,
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

  const url = `https://${cfg.domain}/authorize?${params.toString()}`;
  const session: PkceSession = {
    env,
    domain: cfg.domain,
    client_id: cfg.client_id,
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
  env: keyof typeof ENV_CONFIGS = "prod",
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
  let domain: string = ENV_CONFIGS[env].domain;
  let clientId: string = ENV_CONFIGS[env].client_id;
  let redirectUri = REDIRECT_URI;

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
  const payload = {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
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
    throw new Error("No refresh_token found. Please log in using 'jumbo-mcp login'.");
  }

  const domain = tokens?.domain || ENV_CONFIGS.prod.domain;
  const clientId = tokens?.client_id || ENV_CONFIGS.prod.client_id;
  const tokenUrl = `https://${domain}/oauth/token`;

  const payload = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: rToken,
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

export async function getValidAccessToken(): Promise<string | null> {
  const tokenOverride = process.env.JUMBO_TOKEN;
  if (tokenOverride) return tokenOverride.trim();

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

  if (shouldRefresh && refreshToken) {
    try {
      const fresh = await refreshTokens(tokens || undefined);
      accessToken = fresh.access_token;
    } catch (err: any) {
      process.stderr.write(`Warning: Failed to auto-refresh token: ${err.message}\n`);
    }
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

export async function loginCli(env: keyof typeof ENV_CONFIGS = "prod"): Promise<void> {
  const { url } = buildAuthorizeUrl(env);

  console.log("\n" + "=".repeat(70));
  console.log("🚀 JUMBO MCP — AUTHENTICATION");
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
  console.log("   (The browser might show 'Address invalid' or 'Cannot open' — that's normal!)");
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
    const tokens = await exchangeCode(redirectInput, undefined, env);
    console.log("🎉 Successfully authenticated!");
    console.log(`📁 Tokens saved to: ${getTokensFilePath()}`);

    const claims = decodeJwtPayload(tokens.access_token);
    const custId = claims["https://jumbo.com/customerId"];
    const email = claims["https://jumbo.com/username"];
    if (custId) console.log(`👤 Customer ID: ${custId}`);
    if (email) console.log(`📧 Account:     ${email}`);

    console.log("\nYou're all set! You can now use jumbo-mcp in your AI assistant.");
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }
}
