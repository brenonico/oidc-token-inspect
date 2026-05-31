import { afterEach, describe, expect, it } from "vitest";
import { init, teardown } from "../index";

afterEach(() => {
  teardown();
});

describe("inert by default", () => {
  it("does nothing with empty config: no fetch patch, no DOM node", () => {
    const f = window.fetch;
    init({});
    expect(window.fetch).toBe(f);
    expect(document.querySelector("[data-ti-root]")).toBeNull();
  });

  it("does not patch fetch even when enabled (no observer in this etapa)", () => {
    const f = window.fetch;
    init({ enabled: true });
    // The panel may mount, but fetch must NOT be patched — there is no observer.
    expect(window.fetch).toBe(f);
  });

  it("stays inert when enabled is omitted from a non-empty config", () => {
    const f = window.fetch;
    init({ redaction: "mask" });
    expect(window.fetch).toBe(f);
    expect(document.querySelector("[data-ti-root]")).toBeNull();
  });
});
