/**
 * Reads OAuth redirect parameters from `window.location` at install time and on
 * subsequent `popstate` / `hashchange` events.
 *
 *  - Authorization Code:    `?code=...&state=...`
 *  - Implicit / hybrid:     `#access_token=...&state=...`
 *
 * Emits a `RedirectCallback` for each distinct callback seen. Teardown removes
 * the listeners. No history is mutated and nothing is consumed.
 */
export interface RedirectCallback {
  code?: string;
  state?: string;
  accessToken?: string;
  idToken?: string;
  /** `token_type` from an implicit/hybrid fragment response (e.g. "Bearer"). */
  tokenType?: string;
  error?: string;
  errorDescription?: string;
  raw: string;
}

export function installRedirectObserver(onCallback: (cb: RedirectCallback) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const seen = new Set<string>();

  const scan = () => {
    try {
      const cb = readCallback();
      if (!cb) return;
      // Dedupe by raw query+hash so a re-render doesn't double-emit.
      if (seen.has(cb.raw)) return;
      seen.add(cb.raw);
      onCallback(cb);
    } catch {
      /* swallow: observation must never break navigation */
    }
  };

  // Initial scan (landing on the callback URL counts as an event).
  scan();

  window.addEventListener("popstate", scan);
  window.addEventListener("hashchange", scan);

  return () => {
    window.removeEventListener("popstate", scan);
    window.removeEventListener("hashchange", scan);
  };
}

/** Parse `code`/`state`/`access_token` from the current location's search + hash. */
export function readCallback(): RedirectCallback | null {
  const loc = window.location;
  const search = loc.search || "";
  const hash = loc.hash && loc.hash.length > 1 ? loc.hash.slice(1) : "";

  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  // The hash fragment of an implicit/hybrid response is itself form-encoded.
  const h = new URLSearchParams(hash);

  const code = q.get("code") ?? undefined;
  const state = q.get("state") ?? h.get("state") ?? undefined;
  const accessToken = h.get("access_token") ?? undefined;
  const idToken = h.get("id_token") ?? undefined;
  const tokenType = h.get("token_type") ?? undefined;
  const error = q.get("error") ?? h.get("error") ?? undefined;
  const errorDescription = q.get("error_description") ?? h.get("error_description") ?? undefined;

  const hasSomething = code || accessToken || idToken || (error && state);
  if (!hasSomething) return null;

  return {
    code,
    state,
    accessToken,
    idToken,
    tokenType,
    error,
    errorDescription,
    raw: `${search}|${hash}`,
  };
}
