import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { init, teardown } from "../index";

afterEach(() => {
  act(() => {
    teardown();
  });
});

// End-to-end through the PUBLIC init()/teardown() surface: the ClientObserver is
// wired in only when capabilities.clientObserver is true, and the master
// teardown restores every patched global.
describe("init() observer wiring (opt-in)", () => {
  it("patches fetch + XHR only when clientObserver is true, and restores on teardown", () => {
    const fetchRef = window.fetch;
    const openRef = XMLHttpRequest.prototype.open;

    act(() => {
      init({ enabled: true, capabilities: { clientObserver: true, storageScan: false, correlation: { enabled: false, header: "traceparent", allowlist: ["self"] } } });
    });

    expect(window.fetch).not.toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).not.toBe(openRef);
    // The panel still mounts alongside the observer.
    expect(document.querySelector("[data-ti-root]")).not.toBeNull();

    act(() => {
      teardown();
    });

    expect(window.fetch).toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).toBe(openRef);
    expect(document.querySelector("[data-ti-root]")).toBeNull();
  });

  it("leaves fetch + XHR untouched when clientObserver is false (default)", () => {
    const fetchRef = window.fetch;
    const openRef = XMLHttpRequest.prototype.open;

    act(() => {
      init({ enabled: true }); // observer defaults off
    });

    expect(window.fetch).toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).toBe(openRef);
  });
});
