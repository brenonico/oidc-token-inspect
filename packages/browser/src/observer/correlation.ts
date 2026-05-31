/**
 * Opt-in correlation header injection (spec §7.7).
 *
 * This module is the ONLY place that can add a request header. It is wired into
 * the fetch/XHR wraps exclusively when `capabilities.correlation.enabled` is
 * true (default false). Everything here is built to honour the non-negotiable
 * invariants:
 *
 *  - Default off: when correlation is disabled the injector is never built, so
 *    the Etapa 6 pass-through behaviour stays byte-identical.
 *  - Anonymized header name: defaults to the W3C-neutral `traceparent`. Any name
 *    that identifies the tool (starts with `x-token-inspect`, case-insensitive)
 *    is REFUSED and falls back to `traceparent`.
 *  - Same-origin / allowlist ONLY: cross-origin requests not explicitly listed
 *    receive nothing — this avoids CORS preflight breakage and cross-origin
 *    leakage. No wildcards. `"self"` means same-origin.
 *  - Never override the host's header: if the request already carries the
 *    header, it is left untouched.
 *  - Never break the host: all of this is best-effort; failures fall back to the
 *    original unmodified request (the caller wraps usage in try/catch too).
 */

/** The neutral default header name; also the safe fallback for refused names. */
export const DEFAULT_HEADER_NAME = "traceparent";

/** Prefix we refuse: a tool-identifying header must never be injected. */
const FORBIDDEN_PREFIX = "x-token-inspect";

/**
 * Generate a W3C `traceparent` value:
 *   "00-" + 32 hex (trace-id) + "-" + 16 hex (parent-id/span-id) + "-01"
 *
 * Uses `crypto.getRandomValues` when available (preferred), with a deterministic
 * non-crypto fallback so it also works in environments lacking WebCrypto (e.g.
 * some jsdom setups). The value is opaque correlation data — it carries no
 * identity of the tool.
 */
export function generateTraceparent(): string {
  const traceId = randomHex(16); // 16 bytes -> 32 hex chars
  const spanId = randomHex(8); //  8 bytes -> 16 hex chars
  return `00-${traceId}-${spanId}-01`;
}

/** Return `byteLen` random bytes as a lowercase hex string. */
function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(bytes);
    } else {
      fillPseudoRandom(bytes);
    }
  } catch {
    fillPseudoRandom(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Non-crypto fallback used only when WebCrypto is unavailable. */
function fillPseudoRandom(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}

/**
 * Decide whether the header may be injected for `url`.
 *
 * Returns true ONLY when the resolved request origin is same-origin, OR its host
 * is explicitly listed in `allowlist`. The token `"self"` is an alias for
 * same-origin. There are NO wildcards. Any malformed URL, or a missing
 * `location`, yields false (fail-closed → no injection).
 */
export function shouldInject(url: string, allowlist: string[]): boolean {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || !loc.href) return false;

    const target = new URL(url, loc.href);

    // Same-origin is always allowed (and is what "self" means).
    if (target.origin === loc.origin) return true;

    if (!Array.isArray(allowlist) || allowlist.length === 0) return false;

    const targetHost = target.host.toLowerCase();
    for (const entry of allowlist) {
      if (typeof entry !== "string") continue;
      const e = entry.trim().toLowerCase();
      if (!e || e === "*") continue; // ignore empty / refuse wildcards
      if (e === "self") continue; // already handled by the same-origin check
      // Exact host match (host = hostname[:port]); also accept a bare hostname.
      if (e === targetHost || e === target.hostname.toLowerCase()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the header name to use. Returns the requested name unless it
 * identifies the tool (starts with `x-token-inspect`, case-insensitive), in
 * which case it falls back to the neutral default. Empty/invalid names also
 * fall back. The result is returned verbatim (case preserved) for legitimate
 * names.
 */
export function resolveHeaderName(name: string): string {
  if (typeof name !== "string") return DEFAULT_HEADER_NAME;
  const trimmed = name.trim();
  if (!trimmed) return DEFAULT_HEADER_NAME;
  if (trimmed.toLowerCase().startsWith(FORBIDDEN_PREFIX)) {
    try {
      (globalThis as { console?: Console }).console?.warn?.(
        `[token-inspect] refusing tool-identifying correlation header "${trimmed}"; using "${DEFAULT_HEADER_NAME}"`,
      );
    } catch {
      /* swallow: warning must never break anything */
    }
    return DEFAULT_HEADER_NAME;
  }
  return trimmed;
}

/**
 * Produce a CLONE of `init` with the header set ONLY IF ABSENT. The caller's
 * `init` and any `Headers`/array/record it holds are NEVER mutated. If the
 * header is already present (host set it), the clone carries the host's value
 * unchanged. On any failure the original `init` is returned as-is.
 */
export function injectIntoInit(
  init: RequestInit | undefined,
  name: string,
  value: string,
): RequestInit {
  try {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    // Never overwrite a header the host already set.
    if (!headers.has(name)) {
      headers.set(name, value);
    }
    return { ...(init ?? {}), headers };
  } catch {
    // Fail-safe: hand back the untouched original so the host call is unharmed.
    return init ?? {};
  }
}

/** True when `init`/`input` already carry `name` (host set it) — case-insensitive. */
export function hasHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string): boolean {
  const lname = name.toLowerCase();
  try {
    if (init?.headers && headersInitHas(init.headers, lname)) return true;
    if (typeof Request !== "undefined" && input instanceof Request) {
      if (input.headers.has(name)) return true;
    }
  } catch {
    /* swallow → treat as absent; injectIntoInit still re-checks via Headers.has */
  }
  return false;
}

function headersInitHas(src: HeadersInit, lname: string): boolean {
  if (typeof Headers !== "undefined" && src instanceof Headers) {
    return src.has(lname);
  }
  if (Array.isArray(src)) {
    return src.some(([k]) => String(k).toLowerCase() === lname);
  }
  if (src && typeof src === "object") {
    return Object.keys(src).some((k) => k.toLowerCase() === lname);
  }
  return false;
}
