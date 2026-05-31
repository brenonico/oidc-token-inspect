import type { LiveTraceSource } from "@token-inspect/core";
import type { TokenInspectConfig } from "../config";
import { installFetchWrap } from "./fetch";
import { installXhrWrap, type XhrInjector } from "./xhr";
import { installRedirectObserver } from "./redirect";
import { Reconstructor } from "./reconstruct";
import {
  generateTraceparent,
  resolveHeaderName,
  shouldInject,
  hasHeader,
} from "./correlation";
import type { CorrelationInjector, NetEvent } from "./types";

export type { NetEvent, CorrelationInjector } from "./types";
export { installFetchWrap } from "./fetch";
export { installXhrWrap, type XhrInjector } from "./xhr";
export { installRedirectObserver } from "./redirect";
export { Reconstructor } from "./reconstruct";
export {
  generateTraceparent,
  shouldInject,
  resolveHeaderName,
  injectIntoInit,
} from "./correlation";
export { isIdpTokenEndpoint, isIdpAuthorizeEndpoint, isIdpHost } from "./idp";

/**
 * Compose the ClientObserver: wrap fetch + XHR (pass-through), watch OAuth
 * redirects, and feed reconstructed FlowRuns into the LiveTraceSource.
 *
 * Returns a SINGLE teardown that restores `window.fetch`,
 * `XMLHttpRequest.prototype.{open,setRequestHeader,send}` and removes the
 * redirect listeners. Installing is opt-in (caller gates on
 * `capabilities.clientObserver`); this function does no gating itself.
 */
export function installObserver(live: LiveTraceSource, config: TokenInspectConfig): () => void {
  const reconstructor = new Reconstructor(live, config);

  const onNetEvent = (e: NetEvent) => {
    try {
      reconstructor.handleNetEvent(e);
    } catch {
      /* swallow */
    }
  };

  // Opt-in correlation (spec §7.7). Built ONLY when explicitly enabled; with it
  // off (the default) NO injector is created and the wraps stay pure
  // pass-through — zero header injection anywhere.
  const corr = config.capabilities?.correlation;
  let fetchInjector: CorrelationInjector | undefined;
  let xhrInjector: XhrInjector | undefined;
  if (corr?.enabled) {
    // Anonymized name (refuses any tool-identifying header) + one opaque
    // traceparent value per observer install (per page/run).
    const headerName = resolveHeaderName(corr.header);
    const allowlist = Array.isArray(corr.allowlist) ? corr.allowlist : [];
    const value = generateTraceparent();

    fetchInjector = (input, init) => {
      try {
        const url = urlOf(input);
        if (!url) return null;
        if (!shouldInject(url, allowlist)) return null; // same-origin / allowlist ONLY
        if (hasHeader(input, init, headerName)) return null; // never override the host
        return { name: headerName, value };
      } catch {
        return null;
      }
    };

    xhrInjector = (_method, url) => {
      try {
        if (!url) return null;
        if (!shouldInject(url, allowlist)) return null; // same-origin / allowlist ONLY
        return { name: headerName, value };
      } catch {
        return null;
      }
    };
  }

  const teardowns: Array<() => void> = [];
  teardowns.push(installFetchWrap(onNetEvent, fetchInjector));
  teardowns.push(installXhrWrap(onNetEvent, xhrInjector));
  teardowns.push(
    installRedirectObserver((cb) => {
      try {
        reconstructor.handleRedirect(cb);
      } catch {
        /* swallow */
      }
    }),
  );

  return () => {
    for (const t of teardowns.reverse()) {
      try {
        t();
      } catch {
        /* swallow: one failing teardown must not block the rest */
      }
    }
  };
}

/** Best-effort URL string from a fetch `input` (string | URL | Request). */
function urlOf(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    return String(input);
  } catch {
    return null;
  }
}
