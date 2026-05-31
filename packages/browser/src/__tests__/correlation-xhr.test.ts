import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, teardown } from "../index";
import type { TokenInspectConfig } from "../config";

// vitest's jsdom serves the page at http://localhost:3000 → that is our origin.
const SAME_ORIGIN = "http://localhost:3000/api/loans";
const CROSS_ORIGIN = "https://api.other.test/loans";

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

/**
 * Build the PUBLIC config. `init()` shallow-merges `userConfig` over the
 * defaults, so the whole `capabilities` object must be supplied verbatim.
 */
function publicConfig(corr: Partial<TokenInspectConfig["capabilities"]["correlation"]> = {}): Partial<TokenInspectConfig> {
  return {
    enabled: true,
    capabilities: {
      clientObserver: true,
      storageScan: false,
      correlation: { enabled: true, header: "traceparent", allowlist: ["self"], ...corr },
    },
  };
}

// Native prototype methods captured before any patching, restored after each
// test. The observer reads `proto.{setRequestHeader,send}` at install time and
// stores them as its "originals" — so by spying/stubbing them HERE, BEFORE
// init(), the observer captures our stubs:
//   - origSetHeader (our spy) records exactly what the injector adds.
//   - origSend (our stub) prevents any real jsdom network attempt → hermetic.
let nativeOpen: typeof XMLHttpRequest.prototype.open;
let nativeSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
let nativeSend: typeof XMLHttpRequest.prototype.send;

/** All [name, value] pairs reaching the REAL setRequestHeader, in order. */
let headerCalls: Array<[string, string]>;

beforeEach(() => {
  nativeOpen = XMLHttpRequest.prototype.open;
  nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  nativeSend = XMLHttpRequest.prototype.send;

  headerCalls = [];
  // Stub the native methods. These become the observer's "originals".
  XMLHttpRequest.prototype.setRequestHeader = vi.fn(function (this: XMLHttpRequest, name: string, value: string) {
    headerCalls.push([name, value]);
  }) as unknown as typeof XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.send = vi.fn(function (this: XMLHttpRequest) {
    /* hermetic: never hit the network */
  }) as unknown as typeof XMLHttpRequest.prototype.send;
});

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
  // Restore the native prototype methods regardless of teardown order.
  XMLHttpRequest.prototype.open = nativeOpen;
  XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
  XMLHttpRequest.prototype.send = nativeSend;
});

/** Last value the REAL setRequestHeader saw for `name` (case-insensitive), or null. */
function injectedHeader(name: string): string | null {
  const lname = name.toLowerCase();
  for (let i = headerCalls.length - 1; i >= 0; i--) {
    if (headerCalls[i][0].toLowerCase() === lname) return headerCalls[i][1];
  }
  return null;
}

/** Drive a single XHR through open → (optional host headers) → send. */
function doXhr(method: string, url: string, hostHeaders: Record<string, string> = {}): void {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);
  for (const [k, v] of Object.entries(hostHeaders)) xhr.setRequestHeader(k, v);
  xhr.send();
}

describe("ClientObserver XHR correlation injection (opt-in)", () => {
  it("injects a valid traceparent on a SAME-ORIGIN XHR when enabled", () => {
    init(publicConfig());
    doXhr("GET", SAME_ORIGIN);

    const tp = injectedHeader("traceparent");
    expect(tp).not.toBeNull();
    expect(tp).toMatch(TRACEPARENT);
  });

  it("does NOT inject on a CROSS-ORIGIN XHR (not on allowlist)", () => {
    init(publicConfig());
    doXhr("GET", CROSS_ORIGIN);

    expect(injectedHeader("traceparent")).toBeNull();
  });

  it("does NOT override a traceparent header the host already set", () => {
    init(publicConfig());
    doXhr("GET", SAME_ORIGIN, { traceparent: "HOST-OWNED" });

    // Exactly one traceparent reached the real setRequestHeader — the host's.
    const tpCalls = headerCalls.filter(([n]) => n.toLowerCase() === "traceparent");
    expect(tpCalls).toHaveLength(1);
    expect(tpCalls[0][1]).toBe("HOST-OWNED");
    expect(injectedHeader("traceparent")).toBe("HOST-OWNED");
  });

  it("injects NOTHING via XHR when correlation.enabled is false", () => {
    init(publicConfig({ enabled: false }));
    doXhr("GET", SAME_ORIGIN);

    expect(injectedHeader("traceparent")).toBeNull();
    expect(headerCalls).toHaveLength(0);
  });
});
