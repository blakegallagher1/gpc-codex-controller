/**
 * Minimal OAuth 2.1 provider for MCP authorization (RFC 9728 + PKCE).
 *
 * ChatGPT's MCP connector requires the full OAuth 2.1 discovery flow
 * before it will connect to a remote MCP server. This implements just
 * enough to satisfy that requirement for a single-user deployment:
 *
 *   - Protected Resource Metadata (RFC 9728)
 *   - OAuth Authorization Server Metadata (RFC 8414)
 *   - Dynamic Client Registration (RFC 7591)
 *   - Authorization Code + PKCE (RFC 7636)
 *   - Token Exchange
 *
 * Everything is in-memory — no persistence needed since ChatGPT
 * re-registers on each reconnect.
 */
import crypto from "node:crypto";

/* ---------- Types ---------- */

interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string | undefined;
  registeredAt: number;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string | undefined;
  expiresAt: number;
}

interface IssuedToken {
  access_token: string;
  clientId: string;
  scope: string;
  resource: string | undefined;
  expiresAt: number;
}

/* ---------- Provider ---------- */

export class OAuthProvider {
  private clients = new Map<string, RegisteredClient>();
  private authCodes = new Map<string, AuthCode>();
  private tokens = new Map<string, IssuedToken>();

  private readonly issuer: string;
  private readonly tokenLifetimeMs = 24 * 3600 * 1000; // 24 hours
  private readonly codeLifetimeMs = 600 * 1000; // 10 minutes

  constructor(issuer: string) {
    // Ensure no trailing slash
    this.issuer = issuer.replace(/\/+$/, "");
  }

  /* ---- Discovery Endpoints ---- */

  /** GET /.well-known/oauth-protected-resource */
  getProtectedResourceMetadata(): object {
    return {
      resource: this.issuer,
      authorization_servers: [this.issuer],
      scopes_supported: ["mcp:tools"],
    };
  }

  /** GET /.well-known/oauth-authorization-server */
  getAuthorizationServerMetadata(): object {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: ["mcp:tools"],
    };
  }

  /* ---- Dynamic Client Registration ---- */

  /** POST /oauth/register */
  registerClient(body: Record<string, unknown>): object {
    this.cleanupExpired();

    const clientId = `client_${crypto.randomBytes(16).toString("hex")}`;
    const clientSecret = `secret_${crypto.randomBytes(32).toString("hex")}`;

    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as string[])
      : [];

    const client: RegisteredClient = {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      registeredAt: Date.now(),
    };

    this.clients.set(clientId, client);

    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(client.registeredAt / 1000),
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      client_name: client.client_name,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  /* ---- Authorization ---- */

  /**
   * GET /oauth/authorize
   *
   * For this single-user deployment we auto-approve and redirect
   * immediately with an authorization code. No login screen needed
   * since Cloudflare Access (or lack thereof) handles identity.
   */
  authorize(
    params: URLSearchParams,
  ): { redirectUrl: string } | { error: string; errorDescription: string; status: number } {
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const responseType = params.get("response_type");
    const codeChallenge = params.get("code_challenge");
    const codeChallengeMethod = params.get("code_challenge_method") || "S256";
    const state = params.get("state");
    const scope = params.get("scope") || "mcp:tools";
    const resource = params.get("resource");

    if (!clientId || !this.clients.has(clientId)) {
      return { error: "invalid_client", errorDescription: "Unknown client_id", status: 400 };
    }
    if (responseType !== "code") {
      return { error: "unsupported_response_type", errorDescription: "Only 'code' is supported", status: 400 };
    }
    if (!codeChallenge) {
      return { error: "invalid_request", errorDescription: "code_challenge is required (PKCE)", status: 400 };
    }
    if (codeChallengeMethod !== "S256") {
      return { error: "invalid_request", errorDescription: "Only S256 code_challenge_method is supported", status: 400 };
    }
    if (!redirectUri) {
      return { error: "invalid_request", errorDescription: "redirect_uri is required", status: 400 };
    }

    // Generate authorization code
    const code = crypto.randomBytes(32).toString("hex");
    this.authCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource: resource || undefined,
      expiresAt: Date.now() + this.codeLifetimeMs,
    });

    // Auto-approve: redirect back with code
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);

    return { redirectUrl: redirect.toString() };
  }

  /* ---- Token Exchange ---- */

  /** POST /oauth/token */
  exchangeToken(
    body: Record<string, string>,
  ): { token: object } | { error: string; errorDescription: string; status: number } {
    const grantType = body.grant_type;
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;
    const clientId = body.client_id;

    if (grantType !== "authorization_code") {
      return { error: "unsupported_grant_type", errorDescription: "Only authorization_code is supported", status: 400 };
    }

    if (!code || !this.authCodes.has(code)) {
      return { error: "invalid_grant", errorDescription: "Unknown or expired authorization code", status: 400 };
    }

    const authCode = this.authCodes.get(code)!;
    this.authCodes.delete(code); // one-time use

    if (authCode.expiresAt < Date.now()) {
      return { error: "invalid_grant", errorDescription: "Authorization code has expired", status: 400 };
    }

    if (authCode.clientId !== clientId) {
      return { error: "invalid_grant", errorDescription: "client_id mismatch", status: 400 };
    }

    if (authCode.redirectUri !== redirectUri) {
      return { error: "invalid_grant", errorDescription: "redirect_uri mismatch", status: 400 };
    }

    // Verify PKCE
    if (!codeVerifier) {
      return { error: "invalid_request", errorDescription: "code_verifier is required (PKCE)", status: 400 };
    }

    const expectedChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    if (expectedChallenge !== authCode.codeChallenge) {
      return { error: "invalid_grant", errorDescription: "PKCE code_verifier verification failed", status: 400 };
    }

    // Issue access token
    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresIn = Math.floor(this.tokenLifetimeMs / 1000);

    this.tokens.set(accessToken, {
      access_token: accessToken,
      clientId,
      scope: authCode.scope,
      resource: authCode.resource,
      expiresAt: Date.now() + this.tokenLifetimeMs,
    });

    return {
      token: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: authCode.scope,
      },
    };
  }

  /* ---- Token Verification ---- */

  /** Verify an OAuth-issued bearer token on MCP requests. */
  verifyToken(token: string): boolean {
    const issued = this.tokens.get(token);
    if (!issued) return false;
    if (issued.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /* ---- Cleanup ---- */

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, code] of this.authCodes) {
      if (code.expiresAt < now) this.authCodes.delete(key);
    }
    for (const [key, token] of this.tokens) {
      if (token.expiresAt < now) this.tokens.delete(key);
    }
    // Remove clients older than 30 days
    const thirtyDays = 30 * 24 * 3600 * 1000;
    for (const [key, client] of this.clients) {
      if (client.registeredAt + thirtyDays < now) this.clients.delete(key);
    }
  }
}
