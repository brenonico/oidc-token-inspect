import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { init, teardown } from "../index";

afterEach(() => {
  // Teardown unmounts a React root, so wrap it to flush cleanly.
  act(() => {
    teardown();
  });
});

// `IS_REACT_ACT_ENVIRONMENT` (set in test-setup) makes React 18 require act()
// around anything that mounts/updates a root, so every init/teardown that
// actually mounts the panel is wrapped to flush its async createRoot render.
describe("mount / teardown", () => {
  it("mounts a single host node when enabled and removes it on teardown", () => {
    act(() => {
      init({ enabled: true });
    });
    expect(document.querySelector("[data-ti-root]")).not.toBeNull();
    act(() => {
      teardown();
    });
    expect(document.querySelector("[data-ti-root]")).toBeNull();
  });

  it("is idempotent: init twice mounts only one root", () => {
    act(() => {
      init({ enabled: true });
      init({ enabled: true });
    });
    expect(document.querySelectorAll("[data-ti-root]").length).toBe(1);
  });

  it("renders inside a closed Shadow DOM by default (shadow not accessible)", () => {
    act(() => {
      init({ enabled: true });
    });
    const host = document.querySelector("[data-ti-root]");
    expect(host).not.toBeNull();
    // Closed shadow roots are not exposed via element.shadowRoot.
    expect((host as HTMLElement).shadowRoot).toBeNull();
  });

  it("renders into the host div directly when shadowDom is disabled", () => {
    act(() => {
      init({ enabled: true, mount: { dock: "bottom", shadowDom: false } });
    });
    const host = document.querySelector("[data-ti-root]");
    expect(host).not.toBeNull();
    // Without a shadow root the panel's toggle button is in the light DOM.
    expect(host?.querySelector(".ti-toggle")).not.toBeNull();
  });
});
