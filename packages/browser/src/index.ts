import { defaultConfig, type TokenInspectConfig } from "./config";
import { applyPreset, type DeepPartial } from "./presets";
import { CompositeTraceSource, HttpTraceSource, LiveTraceSource, type TraceJournal, type TraceSource } from "@token-inspect/core";
import { installPanel } from "./install";
import { installObserver } from "./observer";

let teardowns: Array<() => void> | null = null;
let liveSource: LiveTraceSource | null = null;
let frozenConfig: Readonly<TokenInspectConfig> | null = null;

// Egress target, captured ONCE at module load and never re-read from a mutable
// config at runtime. The plugin transmits nothing off-origin in this PoC; this
// makes the property explicit and tamper-evident: even if a caller mutates the
// config (or the egress object) after init(), the value the plugin "knows" is
// fixed and not runtime-repointable (spec §7 anti-exfiltration).
let egressEndpoint: string | undefined;

// Pristine, frozen-at-load references to the globals the observer may wrap.
// selfTest() compares the live globals against these to prove a clean restore.
const PRISTINE_FETCH: typeof window.fetch | undefined =
  typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch : undefined;
const PRISTINE_XHR_OPEN: XMLHttpRequest["open"] | undefined =
  typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.open : undefined;

/**
 * Heuristic prod detection (spec §7 hard-stop). Returns true when the current
 * host looks like a real deployment rather than a local/dev environment.
 *
 *  - No `window` (SSR / Node) → never "prod" (nothing to protect).
 *  - localhost / 127.0.0.1 / ::1 / *.local → never prod (dev hosts).
 *  - An explicit `?ti-dev=1` (or `&ti-dev=1`) query flag → opt back into dev.
 *  - Anything else → treated as prod.
 */
function looksLikeProd(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(h) || h.endsWith(".local")) return false;
  return !/[?&]ti-dev=1\b/.test(window.location.search);
}

/**
 * Initialise the drop-in token-inspect panel.
 *
 * Inert by default: with empty config or `enabled:false` this does ABSOLUTELY
 * nothing — no DOM node, no panel, no monkey-patching. Idempotent: a second
 * call while already initialised is a no-op.
 *
 * Prod hard-stop: on a prod-like host (see {@link looksLikeProd}), enabling
 * WITHOUT `ackExposesTokens` is refused — no mount, no patch — so the tool can
 * never accidentally expose tokens in a real deployment. Localhost (and the
 * `?ti-dev=1` escape hatch) is never treated as prod.
 *
 * The ClientObserver (fetch/XHR wrap + OAuth reconstruction) is installed ONLY
 * when `capabilities.clientObserver === true`. With it false (the default),
 * `window.fetch` and `XMLHttpRequest` are left untouched.
 *
 * When `userConfig.preset` is set, the effective config is resolved with the
 * precedence `defaultConfig < preset defaults < userConfig` — the user's
 * explicit config always wins over a preset. A preset only takes effect when
 * the user opts into it AND `enabled:true`; it never bypasses the inert default.
 */
export function init(userConfig: DeepPartial<TokenInspectConfig>): void {
  if (teardowns) return; // idempotent
  const cfg: TokenInspectConfig = resolveConfig(userConfig);
  if (!cfg.enabled) return; // INERT

  // Prod hard-stop: refuse to enable on a prod-like host without an explicit
  // acknowledgement that this exposes tokens. Placed AFTER the inert check and
  // BEFORE any mount/patch, so a refusal leaves the page completely untouched.
  if (looksLikeProd() && !cfg.ackExposesTokens) {
    // eslint-disable-next-line no-console
    console.warn("[TokenInspect] refusing to enable in prod without ackExposesTokens");
    return;
  }

  // Freeze the resolved config (and its egress sub-object) so neither the
  // running instance nor a later mutation can repoint it. We freeze a private
  // COPY of egress, not the caller's object: the deep-merge may have aliased the
  // user's `{ endpoint }` straight through, and we must not silently freeze a
  // structure the host still owns. The copy makes the egress target ours,
  // immutable, and decoupled from any later mutation of the passed-in object.
  const snapshot: TokenInspectConfig = { ...cfg };
  if (snapshot.egress) snapshot.egress = Object.freeze({ ...snapshot.egress });
  frozenConfig = Object.freeze(snapshot);
  // Capture the egress target ONCE; the plugin never re-reads it from a mutable
  // source. Mutating the original config afterwards cannot change this value.
  egressEndpoint = frozenConfig.egress?.endpoint;

  liveSource = new LiveTraceSource();

  // Resolve the effective TraceSource based on egress + clientObserver:
  //  - egress only           → HttpTraceSource (server modes: BFF/recorder)
  //  - clientObserver only   → LiveTraceSource (pure browser observation)
  //  - both                  → CompositeTraceSource merged by correlationId
  let source: TraceSource = liveSource;
  if (egressEndpoint) {
    const httpClient = {
      get: <T = TraceJournal>(path: string): Promise<T> =>
        fetch(path, { credentials: "include" }).then((r) => r.json() as Promise<T>),
    };
    const httpSource = new HttpTraceSource(httpClient, egressEndpoint);
    source = cfg.capabilities?.clientObserver
      ? new CompositeTraceSource([liveSource, httpSource])
      : httpSource;
  }

  const collected: Array<() => void> = [];
  collected.push(installPanel(frozenConfig, source));

  // Opt-in ONLY: without clientObserver, nothing is patched.
  if (cfg.capabilities?.clientObserver) {
    collected.push(installObserver(liveSource, frozenConfig));
  }

  teardowns = collected;
}

/** Tear down everything init() created and reset module state. */
export function teardown(): void {
  try {
    if (teardowns) {
      // Reverse order: observer (added last) is restored before the panel.
      for (const t of [...teardowns].reverse()) {
        try {
          t();
        } catch {
          /* swallow: one failing teardown must not block the rest */
        }
      }
    }
  } finally {
    teardowns = null;
    liveSource = null;
    frozenConfig = null;
    egressEndpoint = undefined;
  }
}

/**
 * Post-teardown self-test (spec §7). Compares the LIVE globals against the
 * pristine references captured at module load and reports whether the observer
 * left anything behind.
 *
 *  - `fetchRestored`: `window.fetch` is the pristine original (or both absent).
 *  - `xhrRestored`: `XMLHttpRequest.prototype.open` is the pristine original.
 *  - `noResidualListeners`: the observer's wrap markers are gone, i.e. neither
 *    `window.fetch` nor `XMLHttpRequest.prototype.open` is still flagged
 *    `__tokenInspectWrapped` (the redirect listeners are torn down in lockstep
 *    with those wraps, so an unwrapped state implies no residual listeners).
 *
 * After a full `teardown()` all three are true.
 */
export function selfTest(): {
  fetchRestored: boolean;
  xhrRestored: boolean;
  noResidualListeners: boolean;
} {
  const liveFetch = typeof window !== "undefined" ? window.fetch : undefined;
  const liveOpen = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.open : undefined;

  const fetchRestored = liveFetch === PRISTINE_FETCH;
  const xhrRestored = liveOpen === PRISTINE_XHR_OPEN;

  const fetchWrapped = !!(liveFetch as unknown as { __tokenInspectWrapped?: boolean } | undefined)
    ?.__tokenInspectWrapped;
  const openWrapped = !!(liveOpen as unknown as { __tokenInspectWrapped?: boolean } | undefined)
    ?.__tokenInspectWrapped;
  const noResidualListeners = !fetchWrapped && !openWrapped;

  return { fetchRestored, xhrRestored, noResidualListeners };
}

/**
 * The egress target captured at init() time (spec §7 anti-exfiltration).
 *
 * Exposed for diagnostics/tests so the "fixed at load, not runtime-repointable"
 * guarantee is observable: mutating the passed-in config (or its egress object)
 * after init() never changes this value. Returns `undefined` when not enabled or
 * when no egress endpoint was configured.
 */
export function getEgressEndpoint(): string | undefined {
  return egressEndpoint;
}

/**
 * Resolve the effective config from a user-supplied partial, applying any named
 * preset with the precedence `defaultConfig < preset defaults < userConfig`.
 *
 * Exported so callers (and tests) can inspect the resolved config WITHOUT side
 * effects — resolving never patches a global, mounts a panel or enables a
 * capability. When no preset is set this is equivalent to a deep-merge of
 * `userConfig` over `defaultConfig`.
 */
export function resolveConfig(userConfig: DeepPartial<TokenInspectConfig>): TokenInspectConfig {
  return applyPreset(defaultConfig, userConfig.preset as TokenInspectConfig["preset"], userConfig);
}

export { defaultConfig } from "./config";
export type { TokenInspectConfig } from "./config";
export { presets, presetPatches, applyPreset, deepMerge } from "./presets";
export type { PresetName, DeepPartial } from "./presets";
export { findIdpFromTraffic, findTokensInStorage, labelLaneByHost } from "./observer/autodetect";

if (typeof window !== "undefined") {
  (window as { TokenInspect?: unknown }).TokenInspect = { init, teardown, selfTest };
}
