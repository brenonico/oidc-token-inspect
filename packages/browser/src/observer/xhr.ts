import type { NetEvent, NetRequestMeta, NetResponseMeta } from "./types";

/**
 * Reversible wrap of `XMLHttpRequest.prototype.{open,setRequestHeader,send}`.
 *
 * Per-request state (method/url/headers/body) is stashed on the XHR instance via
 * a non-enumerable symbol so it never collides with host code. The originals are
 * stored and restored on teardown. As with fetch, the host send happens first;
 * all instrumentation is best-effort and swallows its own errors.
 *
 * XHR exposes `responseText`/`status` as plain readable properties — reading
 * them does NOT consume a stream, so no clone is needed.
 */
const STATE = Symbol("tokenInspectXhrState");

interface XhrState {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyParams?: Record<string, string>;
}

type Patchable = XMLHttpRequest & { [STATE]?: XhrState };

/**
 * Opt-in correlation injector for XHR. Given the resolved method+url it returns
 * the header to add, or null to inject nothing. Supplied ONLY when
 * `capabilities.correlation.enabled` is true (default off → undefined → the
 * Etapa 6 pass-through path, byte-identical).
 */
export type XhrInjector = (method: string, url: string) => { name: string; value: string } | null;

export function installXhrWrap(onEvent: (e: NetEvent) => void, inject?: XhrInjector): () => void {
  if (typeof XMLHttpRequest === "undefined") return () => {};
  const proto = XMLHttpRequest.prototype;
  if ((proto.open as unknown as { __tokenInspectWrapped?: boolean }).__tokenInspectWrapped) {
    return () => {};
  }

  const origOpen = proto.open;
  const origSetHeader = proto.setRequestHeader;
  const origSend = proto.send;

  const open = function (this: Patchable, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      this[STATE] = { method: String(method || "GET").toUpperCase(), url: String(url), headers: {} };
    } catch {
      /* swallow */
    }
    // Preserve the exact original signature/return.
    return (origOpen as unknown as (...a: unknown[]) => unknown).call(this, method, url, ...rest);
  };

  const setRequestHeader = function (this: Patchable, name: string, value: string) {
    try {
      const st = this[STATE];
      if (st) st.headers[String(name).toLowerCase()] = String(value);
    } catch {
      /* swallow */
    }
    return origSetHeader.call(this, name, value);
  };

  const send = function (this: Patchable, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const st = this[STATE];
      if (st) {
        st.bodyParams = readBodyParams(body);
        const xhr = this;
        // Opt-in correlation: inject AFTER open (state captured the host's
        // setRequestHeader calls) and BEFORE send, by calling the REAL
        // setRequestHeader. Only when the injector approves and the host has not
        // already set the header. Any failure leaves the request un-injected.
        if (inject) {
          try {
            const h = inject(st.method, st.url);
            if (h && !(h.name.toLowerCase() in st.headers)) {
              origSetHeader.call(xhr, h.name, h.value);
              st.headers[h.name.toLowerCase()] = h.value;
            }
          } catch {
            /* swallow: never break the host send */
          }
        }
        xhr.addEventListener("loadend", () => {
          try {
            onEvent({ kind: "xhr", req: requestMeta(st), res: responseMeta(xhr) });
          } catch {
            /* swallow */
          }
        });
      }
    } catch {
      /* swallow */
    }
    // Host send: body never altered.
    return origSend.call(this, body ?? null);
  };

  (open as unknown as { __tokenInspectWrapped?: boolean }).__tokenInspectWrapped = true;

  proto.open = open as typeof proto.open;
  proto.setRequestHeader = setRequestHeader as typeof proto.setRequestHeader;
  proto.send = send as typeof proto.send;

  return () => {
    if (proto.open === (open as typeof proto.open)) proto.open = origOpen;
    if (proto.setRequestHeader === (setRequestHeader as typeof proto.setRequestHeader)) {
      proto.setRequestHeader = origSetHeader;
    }
    if (proto.send === (send as typeof proto.send)) proto.send = origSend;
  };
}

function requestMeta(st: XhrState): NetRequestMeta {
  return { method: st.method, url: st.url, headers: st.headers, ...(st.bodyParams ? { bodyParams: st.bodyParams } : {}) };
}

function responseMeta(xhr: XMLHttpRequest): NetResponseMeta {
  const headers = parseRawHeaders(safeGetAllResponseHeaders(xhr));
  const meta: NetResponseMeta = { status: xhr.status, headers };
  meta.readTokenJson = async () => {
    try {
      // responseText is a readable property — reading it consumes nothing.
      const text = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : "";
      if (!text) return null;
      const json = JSON.parse(text) as unknown;
      return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return meta;
}

function safeGetAllResponseHeaders(xhr: XMLHttpRequest): string {
  try {
    return xhr.getAllResponseHeaders() || "";
  } catch {
    return "";
  }
}

function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function readBodyParams(body?: Document | XMLHttpRequestBodyInit | null): Record<string, string> | undefined {
  if (body == null) return undefined;
  try {
    if (typeof body === "string") {
      if (body.includes("{") || body.includes("\n") || !body.includes("=")) return undefined;
      const out: Record<string, string> = {};
      new URLSearchParams(body).forEach((v, k) => {
        out[k] = v;
      });
      return Object.keys(out).length ? out : undefined;
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
  return undefined;
}
