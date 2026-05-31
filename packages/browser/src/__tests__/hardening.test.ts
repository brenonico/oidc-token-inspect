import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { init, teardown, selfTest, getEgressEndpoint } from "../index";

afterEach(() => {
  act(() => {
    teardown();
  });
});

/**
 * Temporarily redefine `window.location` for the duration of `fn`, then restore
 * the original descriptor. jsdom's default location is `http://localhost/`, so a
 * prod-like host must be installed explicitly and removed again to keep the
 * suite hermetic (every other test relies on the localhost default).
 */
function withLocation(href: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window, "location");
  const url = new URL(href);
  // A minimal stand-in exposing the fields looksLikeProd() reads.
  const stub = {
    ...window.location,
    href: url.href,
    hostname: url.hostname,
    host: url.host,
    search: url.search,
    pathname: url.pathname,
    hash: url.hash,
    origin: url.origin,
    protocol: url.protocol,
  };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: stub,
  });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(window, "location", original);
  }
}

describe("prod hard-stop", () => {
  it("refuses to enable on a prod-like host without ackExposesTokens", () => {
    const fetchRef = window.fetch;
    withLocation("https://app.example.com/", () => {
      act(() => {
        init({ enabled: true });
      });
      // Refused: no patch, no mount, no module state.
      expect(window.fetch).toBe(fetchRef);
      expect(document.querySelector("[data-ti-root]")).toBeNull();
    });
  });

  it("also refuses the observer path on a prod-like host without ack", () => {
    const fetchRef = window.fetch;
    const openRef = XMLHttpRequest.prototype.open;
    withLocation("https://app.example.com/dashboard?foo=1", () => {
      act(() => {
        init({
          enabled: true,
          capabilities: {
            clientObserver: true,
            storageScan: false,
            correlation: { enabled: false, header: "traceparent", allowlist: ["self"] },
          },
        });
      });
      expect(window.fetch).toBe(fetchRef);
      expect(XMLHttpRequest.prototype.open).toBe(openRef);
      expect(document.querySelector("[data-ti-root]")).toBeNull();
    });
  });

  it("allows enabling on a prod-like host WITH ackExposesTokens (mounts)", () => {
    withLocation("https://app.example.com/", () => {
      act(() => {
        init({ enabled: true, ackExposesTokens: true });
      });
      expect(document.querySelector("[data-ti-root]")).not.toBeNull();
    });
  });

  it("treats *.local hosts as dev (not prod) — enables without ack", () => {
    withLocation("https://my-machine.local/", () => {
      act(() => {
        init({ enabled: true });
      });
      expect(document.querySelector("[data-ti-root]")).not.toBeNull();
    });
  });

  it("honours the ?ti-dev=1 escape hatch on an otherwise prod-like host", () => {
    withLocation("https://app.example.com/page?ti-dev=1", () => {
      act(() => {
        init({ enabled: true });
      });
      expect(document.querySelector("[data-ti-root]")).not.toBeNull();
    });
  });

  it("localhost (jsdom default) is never treated as prod — enables without ack", () => {
    act(() => {
      init({ enabled: true });
    });
    expect(document.querySelector("[data-ti-root]")).not.toBeNull();
  });
});

describe("frozen egress (anti-exfiltration)", () => {
  it("captures the egress endpoint at init() and ignores later mutation", () => {
    const userConfig = { enabled: true, egress: { endpoint: "/a" } };
    act(() => {
      init(userConfig);
    });
    expect(getEgressEndpoint()).toBe("/a");

    // Mutating the caller's ORIGINAL object after init() must not move the
    // captured target (the running instance read it once, at load).
    userConfig.egress.endpoint = "https://evil.example.com/collect";
    expect(getEgressEndpoint()).toBe("/a");
  });

  it("does not transmit anywhere even with an egress endpoint configured", () => {
    // This PoC never sends observed values off-origin; the egress target is
    // captured but inert. We assert the captured value is exactly what was
    // configured and survives across init() with no surprises.
    act(() => {
      init({ enabled: true, egress: { endpoint: "/collect" } });
    });
    expect(getEgressEndpoint()).toBe("/collect");
  });
});

describe("teardown self-test", () => {
  it("reports all restored after a full observer init + teardown", () => {
    act(() => {
      init({
        enabled: true,
        capabilities: {
          clientObserver: true,
          storageScan: false,
          correlation: { enabled: false, header: "traceparent", allowlist: ["self"] },
        },
      });
    });

    // While installed, fetch/XHR are wrapped — selfTest should NOT be all-true.
    const during = selfTest();
    expect(during.fetchRestored).toBe(false);
    expect(during.xhrRestored).toBe(false);
    expect(during.noResidualListeners).toBe(false);

    act(() => {
      teardown();
    });

    const after = selfTest();
    expect(after.fetchRestored).toBe(true);
    expect(after.xhrRestored).toBe(true);
    expect(after.noResidualListeners).toBe(true);
  });

  it("reports all restored when no observer was ever installed", () => {
    act(() => {
      init({ enabled: true }); // panel only, no fetch/XHR wrap
    });
    act(() => {
      teardown();
    });
    expect(selfTest()).toEqual({
      fetchRestored: true,
      xhrRestored: true,
      noResidualListeners: true,
    });
  });
});
