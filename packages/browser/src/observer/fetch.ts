import type { CorrelationInjector, NetEvent, NetRequestMeta, NetResponseMeta } from "./types";
import { injectIntoInit } from "./correlation";

/**
 * Reversible, non-invasive wrap of `window.fetch`.
 *
 * Invariants honoured here:
 *  - The ORIGINAL fetch is called first and its exact promise is returned.
 *  - ALL instrumentation runs inside try/catch that swallows errors, so an
 *    observer fault never affects the host call.
 *  - `this`, arguments and the return value are preserved.
 *  - Request/response bodies are NEVER consumed: we read only metadata, and the
 *    response body is read from a `clone()` (the host's body stays intact).
 *  - Double-wrap is refused via a `__tokenInspectWrapped` marker.
 *  - Teardown restores the original `window.fetch`.
 *
 * The optional `inject` argument enables opt-in correlation header injection
 * (spec §7.7). It is supplied ONLY when `capabilities.correlation.enabled` is
 * true; with no injector (the Etapa 6 path) behaviour is byte-identical — the
 * caller's `input`/`init` reach the original fetch verbatim. When present and it
 * returns a `{ name, value }`, we pass the original a CLONE of `init` carrying
 * the header (set only if absent); the caller's own object is never mutated. Any
 * injection failure falls back to the un-injected call.
 */
export function installFetchWrap(
  onEvent: (e: NetEvent) => void,
  inject?: CorrelationInjector,
): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return () => {};
  }
  const original = window.fetch;
  if ((original as unknown as { __tokenInspectWrapped?: boolean }).__tokenInspectWrapped) {
    return () => {};
  }

  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    // Opt-in correlation: only when an injector is supplied AND it returns a
    // header. On any failure we keep the original init untouched.
    let callInit = init;
    if (inject) {
      try {
        const h = inject(input, init);
        if (h) callInit = injectIntoInit(init, h.name, h.value);
      } catch {
        callInit = init; // never break the host on an injection fault
      }
    }
    // Host call FIRST — with either the original init (no injection) or a clone
    // carrying the correlation header. We never mutate the caller's object.
    const promise = original.call(this as typeof window, input as RequestInfo, callInit);
    try {
      const req = normalizeRequest(input, init);
      promise.then(
        (res) => {
          try {
            onEvent({ kind: "fetch", req, res: cloneMeta(res, req) });
          } catch {
            /* swallow: instrumentation must not affect the host */
          }
        },
        () => {
          /* swallow rejection in instrumentation; the host still sees its own */
        },
      );
    } catch {
      /* swallow: building metadata must never break the call */
    }
    return promise;
  };

  (wrapped as unknown as { __tokenInspectWrapped?: boolean }).__tokenInspectWrapped = true;
  window.fetch = wrapped as typeof fetch;

  return () => {
    if (window.fetch === (wrapped as typeof fetch)) window.fetch = original;
  };
}

/** Extract method/url/headers (and form params for readable bodies) without consuming a stream. */
function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): NetRequestMeta {
  let url = "";
  let method = "GET";
  const headers: Record<string, string> = {};

  // A Request object carries its own method/url/headers; a string/URL is just a URL.
  if (typeof Request !== "undefined" && input instanceof Request) {
    url = input.url;
    method = input.method || "GET";
    readHeaders(input.headers, headers);
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = String(input);
  }

  if (init?.method) method = init.method;
  if (init?.headers) readHeaders(init.headers, headers);

  const bodyParams = init ? readBodyParams(init.body) : undefined;

  return { method: method.toUpperCase(), url, headers, ...(bodyParams ? { bodyParams } : {}) };
}

/** Read only string/URLSearchParams/record/Headers bodies — NEVER a ReadableStream/Blob/FormData. */
function readBodyParams(body: BodyInit | null | undefined): Record<string, string> | undefined {
  if (body == null) return undefined;
  try {
    if (typeof body === "string") {
      return parseFormEncoded(body);
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      const out: Record<string, string> = {};
      body.forEach((v, k) => {
        out[k] = v;
      });
      return out;
    }
  } catch {
    /* swallow */
  }
  // Blob, ArrayBuffer, FormData, ReadableStream: do NOT touch (would risk consuming).
  return undefined;
}

function parseFormEncoded(s: string): Record<string, string> | undefined {
  // Only treat clearly form-encoded payloads as params; skip JSON / arbitrary text.
  if (!s || s.includes("{") || s.includes("\n")) return undefined;
  if (!s.includes("=")) return undefined;
  try {
    const out: Record<string, string> = {};
    new URLSearchParams(s).forEach((v, k) => {
      out[k] = v;
    });
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function readHeaders(src: HeadersInit, into: Record<string, string>): void {
  try {
    if (typeof Headers !== "undefined" && src instanceof Headers) {
      src.forEach((v, k) => {
        into[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(src)) {
      for (const [k, v] of src) into[String(k).toLowerCase()] = String(v);
    } else if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) into[k.toLowerCase()] = String(v);
    }
  } catch {
    /* swallow */
  }
}

/**
 * Read response status/headers WITHOUT consuming the host body. A `clone()` is
 * taken synchronously (cloning a Response never consumes the original) so the
 * consumer can lazily read the COPY's JSON; the host's `res.body` is untouched.
 */
function cloneMeta(res: Response, _req: NetRequestMeta): NetResponseMeta {
  const headers: Record<string, string> = {};
  try {
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
  } catch {
    /* swallow */
  }
  const meta: NetResponseMeta = { status: res.status, headers };

  // Clone now (cheap, does not read the body). The clone has its own stream, so
  // reading it later cannot interfere with whatever the host does to `res`.
  let clone: Response | null = null;
  try {
    clone = res.clone();
  } catch {
    clone = null;
  }
  if (clone) {
    meta.readTokenJson = async () => {
      try {
        const json = (await clone!.json()) as unknown;
        return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
  }
  return meta;
}
