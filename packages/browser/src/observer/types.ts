/**
 * Local, host-agnostic event shapes emitted by the network wraps (fetch/XHR).
 *
 * These are intentionally NOT exported from `@token-inspect/core`: they describe
 * only the *metadata* the observer is allowed to read without consuming any
 * request/response body or stream. No Keycloak/Redis/host types leak in here.
 */

/** Request metadata extracted without consuming a body stream. */
export interface NetRequestMeta {
  method: string;
  url: string;
  /**
   * Request headers we are allowed to read (set via `setRequestHeader` for XHR
   * or a readable `Headers`/record for fetch). Lower-cased keys.
   */
  headers: Record<string, string>;
  /**
   * Parsed form body params — ONLY populated when the body was passed as a
   * string or URLSearchParams we could read without touching a ReadableStream.
   * Used to recognise `grant_type=authorization_code` token exchanges.
   */
  bodyParams?: Record<string, string>;
}

/** Response metadata extracted without consuming `res.body`. */
export interface NetResponseMeta {
  status: number;
  headers: Record<string, string>;
  /**
   * Lazily reads the JSON token payload from a CLONE of the response. The clone
   * is taken synchronously inside the wrap (cloning never consumes the host's
   * body); reading it here touches only the copy's stream. Returns null if the
   * body is not JSON or already consumed. Present only when a clone was made.
   */
  readTokenJson?: () => Promise<Record<string, unknown> | null>;
}

/** A single observed network exchange (request + its eventual response). */
export interface NetEvent {
  kind: "fetch" | "xhr";
  req: NetRequestMeta;
  res: NetResponseMeta;
}

/**
 * Optional opt-in correlation injector handed to the fetch/XHR wraps.
 *
 * Given the request (fetch `input`/`init`, or an XHR method+url), it decides
 * whether a correlation header may be added and, if so, returns its `{ name,
 * value }`. Returning `null` means "inject nothing" (cross-origin, not on the
 * allowlist, host already set the header, or correlation disabled). The wraps
 * apply the result behind try/catch and fall back to the un-injected call on any
 * failure — instrumentation must never break the host.
 */
export type CorrelationInjector = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
) => { name: string; value: string } | null;
