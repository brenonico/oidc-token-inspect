import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTraceSource } from "@token-inspect/core";
import { installObserver } from "../observer";
import {
  generateTraceparent,
  injectIntoInit,
  resolveHeaderName,
  shouldInject,
} from "../observer/correlation";
import { installFetchWrap } from "../observer/fetch";
import type { TokenInspectConfig } from "../config";
import { defaultConfig } from "../config";

// vitest's jsdom serves the page at http://localhost:3000 → that is our origin.
const SAME_ORIGIN = "http://localhost:3000/api/loans";
const CROSS_ORIGIN = "https://api.other.test/loans";

/** Build a config with correlation overrides applied on top of the defaults. */
function cfg(corr: Partial<TokenInspectConfig["capabilities"]["correlation"]> = {}): TokenInspectConfig {
  return {
    ...defaultConfig,
    enabled: true,
    capabilities: {
      ...defaultConfig.capabilities,
      clientObserver: true,
      correlation: { ...defaultConfig.capabilities.correlation, enabled: true, ...corr },
    },
  };
}

let originalFetch: typeof window.fetch;
/** Each fetch call records the `init` the ORIGINAL fetch actually received. */
let seenInits: Array<RequestInit | undefined>;

function headerFrom(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) return null;
  const h = new Headers(init.headers as HeadersInit);
  return h.has(name) ? h.get(name) : null;
}

beforeEach(() => {
  originalFetch = window.fetch;
  seenInits = [];
  window.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    seenInits.push(init);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof window.fetch;
});

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("generateTraceparent", () => {
  it("matches the W3C traceparent shape", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    }
  });

  it("produces distinct trace/span ids across calls", () => {
    const a = generateTraceparent();
    const b = generateTraceparent();
    expect(a).not.toBe(b);
  });
});

describe("resolveHeaderName", () => {
  it("defaults to traceparent for empty/invalid", () => {
    expect(resolveHeaderName("")).toBe("traceparent");
    expect(resolveHeaderName("   ")).toBe("traceparent");
    expect(resolveHeaderName(undefined as unknown as string)).toBe("traceparent");
  });

  it("keeps a legitimate custom name", () => {
    expect(resolveHeaderName("traceparent")).toBe("traceparent");
    expect(resolveHeaderName("x-correlation-id")).toBe("x-correlation-id");
    expect(resolveHeaderName("My-Trace")).toBe("My-Trace");
  });

  it("refuses any tool-identifying name (case-insensitive) → traceparent", () => {
    expect(resolveHeaderName("x-token-inspect")).toBe("traceparent");
    expect(resolveHeaderName("X-Token-Inspect")).toBe("traceparent");
    expect(resolveHeaderName("X-TOKEN-INSPECT-TRACE")).toBe("traceparent");
    expect(resolveHeaderName("x-token-inspect-anything")).toBe("traceparent");
  });
});

describe("shouldInject", () => {
  it("allows same-origin (absolute and relative)", () => {
    expect(shouldInject(SAME_ORIGIN, [])).toBe(true);
    expect(shouldInject("/api/loans", [])).toBe(true);
    expect(shouldInject("/api/loans", ["self"])).toBe(true);
  });

  it("refuses cross-origin not on the allowlist", () => {
    expect(shouldInject(CROSS_ORIGIN, [])).toBe(false);
    expect(shouldInject(CROSS_ORIGIN, ["self"])).toBe(false);
    expect(shouldInject(CROSS_ORIGIN, ["api.example.test"])).toBe(false);
  });

  it("allows an explicit allowlisted host (with and without port)", () => {
    expect(shouldInject(CROSS_ORIGIN, ["api.other.test"])).toBe(true);
    expect(shouldInject("https://api.other.test:8443/x", ["api.other.test:8443"])).toBe(true);
  });

  it("never honours a wildcard", () => {
    expect(shouldInject(CROSS_ORIGIN, ["*"])).toBe(false);
  });
});

describe("injectIntoInit", () => {
  it("clones and sets the header when absent; never mutates the caller", () => {
    const init: RequestInit = { method: "POST", headers: { "content-type": "x" } };
    const out = injectIntoInit(init, "traceparent", "tp-value");
    expect(out).not.toBe(init);
    expect(init.headers).toEqual({ "content-type": "x" }); // original untouched
    expect(headerFrom(out, "traceparent")).toBe("tp-value");
    expect(headerFrom(out, "content-type")).toBe("x");
  });

  it("does NOT overwrite a header the host already set (any header shape)", () => {
    const recordInit: RequestInit = { headers: { traceparent: "host-record" } };
    expect(headerFrom(injectIntoInit(recordInit, "traceparent", "mine"), "traceparent")).toBe("host-record");

    const headersInit: RequestInit = { headers: new Headers({ traceparent: "host-Headers" }) };
    expect(headerFrom(injectIntoInit(headersInit, "traceparent", "mine"), "traceparent")).toBe("host-Headers");

    const arrInit: RequestInit = { headers: [["traceparent", "host-array"]] };
    expect(headerFrom(injectIntoInit(arrInit, "traceparent", "mine"), "traceparent")).toBe("host-array");
  });

  it("works with no init at all", () => {
    const out = injectIntoInit(undefined, "traceparent", "tp");
    expect(headerFrom(out, "traceparent")).toBe("tp");
  });
});

describe("ClientObserver correlation injection (opt-in)", () => {
  it("injects traceparent on a same-origin request when enabled", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg());
    await window.fetch(SAME_ORIGIN, { method: "GET" });
    teardown();

    const tp = headerFrom(seenInits[0], "traceparent");
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("does NOT inject on a cross-origin request (not on allowlist)", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg());
    await window.fetch(CROSS_ORIGIN, { method: "GET" });
    teardown();

    expect(headerFrom(seenInits[0], "traceparent")).toBeNull();
  });

  it("DEFAULT off: no header injected anywhere when correlation.enabled is false", async () => {
    const live = new LiveTraceSource();
    const noCorr: TokenInspectConfig = {
      ...defaultConfig,
      enabled: true,
      capabilities: { ...defaultConfig.capabilities, clientObserver: true },
    };
    expect(noCorr.capabilities.correlation.enabled).toBe(false);
    const teardown = installObserver(live, noCorr);

    const init: RequestInit = { method: "POST", headers: { "content-type": "x" } };
    await window.fetch(SAME_ORIGIN, init);
    await window.fetch(CROSS_ORIGIN, { method: "GET" });
    teardown();

    // With no injector, the ORIGINAL init object is passed through verbatim.
    expect(seenInits[0]).toBe(init);
    expect(headerFrom(seenInits[0], "traceparent")).toBeNull();
    expect(headerFrom(seenInits[1], "traceparent")).toBeNull();
  });

  it("injects for an explicit allowlisted host; not for a host absent from it", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg({ allowlist: ["self", "api.other.test"] }));

    await window.fetch(CROSS_ORIGIN, { method: "GET" }); // allowlisted
    await window.fetch("https://api.elsewhere.test/x", { method: "GET" }); // not listed
    teardown();

    expect(headerFrom(seenInits[0], "traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headerFrom(seenInits[1], "traceparent")).toBeNull();
  });

  it("never overrides a header the host already set", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg());

    await window.fetch(SAME_ORIGIN, { method: "GET", headers: { traceparent: "HOST-OWNED" } });
    teardown();

    expect(headerFrom(seenInits[0], "traceparent")).toBe("HOST-OWNED");
  });

  it("uses a configurable header name; defaults to traceparent", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg({ header: "x-correlation-id" }));
    await window.fetch(SAME_ORIGIN, { method: "GET" });
    teardown();

    expect(headerFrom(seenInits[0], "x-correlation-id")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headerFrom(seenInits[0], "traceparent")).toBeNull();
  });

  it("refuses a tool-identifying header name and falls back to traceparent", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg({ header: "X-Token-Inspect-Trace" }));
    await window.fetch(SAME_ORIGIN, { method: "GET" });
    teardown();

    expect(headerFrom(seenInits[0], "x-token-inspect-trace")).toBeNull();
    expect(headerFrom(seenInits[0], "traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("the same traceparent value is reused across requests within one install", async () => {
    const live = new LiveTraceSource();
    const teardown = installObserver(live, cfg());
    await window.fetch(SAME_ORIGIN, { method: "GET" });
    await window.fetch("/api/other", { method: "GET" });
    teardown();

    expect(headerFrom(seenInits[0], "traceparent")).toBe(headerFrom(seenInits[1], "traceparent"));
  });
});

describe("installFetchWrap injector contract", () => {
  it("with NO injector, init reaches the original fetch verbatim (Etapa 6 byte-identical)", async () => {
    const init: RequestInit = { method: "POST", headers: { "content-type": "x" } };
    const teardown = installFetchWrap(() => {});
    await window.fetch(SAME_ORIGIN, init);
    teardown();
    expect(seenInits[0]).toBe(init);
  });

  it("an injector that THROWS falls back to the un-injected original init", async () => {
    const init: RequestInit = { method: "POST" };
    const teardown = installFetchWrap(
      () => {},
      () => {
        throw new Error("injector boom");
      },
    );
    await window.fetch(SAME_ORIGIN, init);
    teardown();
    expect(seenInits[0]).toBe(init);
  });
});
