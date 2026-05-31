import type { TokenInspectConfig } from "../config";

/**
 * IdP recognition — decoupled from any concrete IdP product.
 *
 * The token/authorize endpoints are recognised by config (`idp.issuer`) when
 * present, otherwise by a generic OIDC heuristic on the URL path. NOTHING here
 * is hardcoded to Keycloak or this project.
 */

/** Generic OIDC token-endpoint path markers (RFC 8414 / OIDC discovery). */
const TOKEN_PATH_HINTS = ["/protocol/openid-connect/token", "/oauth2/token", "/oauth/token", "/connect/token"];
const AUTHORIZE_PATH_HINTS = [
  "/protocol/openid-connect/auth",
  "/oauth2/authorize",
  "/oauth/authorize",
  "/connect/authorize",
];
const DISCOVERY_HINT = ".well-known/openid-configuration";

function safeUrl(url: string): URL | null {
  try {
    // Resolve relative URLs against the current document origin.
    return new URL(url, typeof window !== "undefined" ? window.location.href : undefined);
  } catch {
    return null;
  }
}

/** Origin (scheme + host + port) of the configured issuer, if any. */
function issuerOrigin(config: TokenInspectConfig): string | null {
  const issuer = config.idp?.issuer;
  if (!issuer) return null;
  const u = safeUrl(issuer);
  return u ? u.origin : null;
}

/** True when `url` points at an OIDC token endpoint (config first, heuristic fallback). */
export function isIdpTokenEndpoint(url: string, config: TokenInspectConfig): boolean {
  const u = safeUrl(url);
  if (!u) return false;
  const origin = issuerOrigin(config);
  const path = u.pathname;
  const tokenLike = TOKEN_PATH_HINTS.some((h) => path.endsWith(h) || path.includes(h));
  if (origin) {
    // Scoped to the configured issuer origin: avoids false positives on
    // unrelated hosts that happen to expose a similarly named path.
    return u.origin === origin && tokenLike;
  }
  return tokenLike;
}

/** True when `url` points at an OIDC authorize endpoint. */
export function isIdpAuthorizeEndpoint(url: string, config: TokenInspectConfig): boolean {
  const u = safeUrl(url);
  if (!u) return false;
  const origin = issuerOrigin(config);
  const path = u.pathname;
  const authLike = AUTHORIZE_PATH_HINTS.some((h) => path.endsWith(h) || path.includes(h));
  if (origin) return u.origin === origin && authLike;
  return authLike;
}

/** True for any IdP endpoint (token, authorize or discovery) — used to skip api.call. */
export function isIdpHost(url: string, config: TokenInspectConfig): boolean {
  const u = safeUrl(url);
  if (!u) return false;
  const origin = issuerOrigin(config);
  if (origin && u.origin === origin) return true;
  if (isIdpTokenEndpoint(url, config) || isIdpAuthorizeEndpoint(url, config)) return true;
  return u.pathname.includes(DISCOVERY_HINT);
}
