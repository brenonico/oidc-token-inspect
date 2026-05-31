/**
 * Auto-detect helpers — pure, inert refinements WITHIN an already-active
 * capability (spec §6: "auto-deteção opera dentro de uma capacidade já ligada").
 *
 * Hard contract for everything in this file:
 *   - NEVER enables a capability (no flipping `clientObserver`/`storageScan`/…).
 *   - NEVER patches a global (no `window.fetch`, no `XMLHttpRequest`, no Storage
 *     wrapping). Every function only READS data passed to it and RETURNS a value.
 *
 * These utilities let an ALREADY-enabled observer reduce required config:
 *   - infer the IdP origin from observed traffic (when `clientObserver` is on),
 *   - locate JWT-looking values in a Storage the caller already chose to scan
 *     (only meaningful when `storageScan` is on — but the function itself just
 *     reads the Storage object handed to it),
 *   - map a request host to a configured lane label.
 */
import { decodeJwt } from "@token-inspect/core";
import type { TokenInspectConfig } from "../config";
import type { NetEvent } from "./types";

/** Generic OIDC endpoint markers — host-agnostic (no Keycloak/product names). */
const TOKEN_PATH_HINTS = ["/protocol/openid-connect/token", "/oauth2/token", "/oauth/token", "/connect/token"];
const AUTHORIZE_PATH_HINTS = [
  "/protocol/openid-connect/auth",
  "/oauth2/authorize",
  "/oauth/authorize",
  "/connect/authorize",
];
const DISCOVERY_HINT = ".well-known/openid-configuration";

/** Loosely "JWT-shaped": three base64url segments separated by dots. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function safeUrl(url: string): URL | null {
  try {
    return new URL(url, typeof window !== "undefined" ? window.location.href : undefined);
  } catch {
    return null;
  }
}

/** True when a path looks like an OIDC token/authorize/discovery endpoint. */
function isOidcPath(path: string): boolean {
  return (
    TOKEN_PATH_HINTS.some((h) => path.endsWith(h) || path.includes(h)) ||
    AUTHORIZE_PATH_HINTS.some((h) => path.endsWith(h) || path.includes(h)) ||
    path.includes(DISCOVERY_HINT)
  );
}

/** Normalise the mixed `events | urls` input into a flat list of URL strings. */
function toUrls(input: ReadonlyArray<NetEvent | string>): string[] {
  const urls: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      if (item) urls.push(item);
    } else if (item && item.req && typeof item.req.url === "string") {
      urls.push(item.req.url);
    }
  }
  return urls;
}

/**
 * Infer the IdP issuer ORIGIN (scheme + host + port) from observed traffic.
 *
 * Accepts either raw URL strings or `NetEvent`s (whose `req.url` is read). The
 * first URL whose path matches a generic OIDC token/authorize/discovery marker
 * wins; its origin is returned. Returns `undefined` when nothing OIDC-shaped is
 * present. PURE: reads only its argument, patches nothing, enables nothing.
 */
export function findIdpFromTraffic(input: ReadonlyArray<NetEvent | string>): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const url of toUrls(input)) {
    const u = safeUrl(url);
    if (u && isOidcPath(u.pathname)) return u.origin;
  }
  return undefined;
}

/**
 * Scan a Storage (localStorage/sessionStorage handed in by the caller) for
 * JWT-looking values. Returns the `{key, value}` entries whose value is a real
 * decodable JWT (shape pre-filter + `decodeJwt` confirmation), ignoring all
 * non-JWT values.
 *
 * This is only MEANINGFUL when `storageScan` is on, but the function enforces
 * nothing about that — it simply reads the passed-in Storage and returns. It
 * does NOT wrap or patch the Storage; the caller owns the decision to call it.
 */
export function findTokensInStorage(storage: Storage | null | undefined): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (!storage) return out;
  let length: number;
  try {
    length = storage.length;
  } catch {
    return out;
  }
  for (let i = 0; i < length; i++) {
    let key: string | null;
    let value: string | null;
    try {
      key = storage.key(i);
      value = key === null ? null : storage.getItem(key);
    } catch {
      continue; // a throwing/locked entry must never break the scan
    }
    if (key === null || typeof value !== "string") continue;
    if (looksLikeJwt(value)) out.push({ key, value });
  }
  return out;
}

/** Shape pre-filter + structural confirmation that `value` is a JWT. */
function looksLikeJwt(value: string): boolean {
  if (!JWT_SHAPE.test(value)) return false;
  return decodeJwt(value) !== null;
}

/**
 * Map a request URL to a configured lane label (`config.apis`). The first entry
 * whose `match` substring appears in the URL's host (or, as a fallback, the full
 * URL) wins. Returns `undefined` when there is no `apis` config or no match.
 * PURE: reads only its arguments.
 */
export function labelLaneByHost(url: string, apis: TokenInspectConfig["apis"]): string | undefined {
  if (!url || !Array.isArray(apis) || apis.length === 0) return undefined;
  const u = safeUrl(url);
  const host = u ? u.host : "";
  for (const entry of apis) {
    if (!entry || typeof entry.match !== "string" || entry.match.length === 0) continue;
    if ((host && host.includes(entry.match)) || url.includes(entry.match)) {
      return entry.lane;
    }
  }
  return undefined;
}
