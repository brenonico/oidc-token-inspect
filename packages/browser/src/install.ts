import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TokenInspectPanel } from "@oidc-token-inspect/react";
import type { TraceSource } from "@oidc-token-inspect/core";
import type { TokenInspectConfig } from "./config";
// The panel's own stylesheet, imported as a raw string (not injected into
// document.head). With `?inline`, Vite/Rollup bundles the CSS text and hands it
// back as the default export, letting us inject it into a closed Shadow DOM
// where document.head styles would never reach. Imported via a relative path to
// the sibling package source (the bare `@oidc-token-inspect/react` alias only maps
// the package root, not subpaths). We do NOT modify styles.css.
import panelCss from "../../react/src/styles.css?inline";

/**
 * Mount the existing TokenInspectPanel into the page.
 *
 * Lifecycle: appends a single `<div data-ti-root>` to `document.body`. When
 * `config.mount.shadowDom` is true the panel renders inside a *closed* Shadow
 * DOM (style-isolated from the host); the bundled CSS text is injected into a
 * `<style>` element in the shadow root so the panel keeps its look. Otherwise
 * the panel renders directly in the host div (debug aid).
 *
 * Returns a teardown that unmounts React, removes the host node and clears any
 * body padding the panel set while open.
 */
export function installPanel(config: TokenInspectConfig, source: TraceSource): () => void {
  const host = document.createElement("div");
  host.setAttribute("data-ti-root", "");
  document.body.appendChild(host);

  let mountTarget: Element | ShadowRoot = host;

  if (config.mount.shadowDom) {
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = panelCss;
    shadow.appendChild(style);
    mountTarget = shadow;
  }

  const root: Root = createRoot(mountTarget);
  root.render(createElement(TokenInspectPanel, { source, app: config.app ?? config.preset }));

  return function teardown(): void {
    root.unmount();
    host.remove();
    // The panel splits the host page by setting body padding while open; its
    // own cleanup effect clears it on unmount, but restore defensively in case
    // unmount raced an open state.
    const b = document.body.style;
    b.paddingBottom = b.paddingRight = b.paddingLeft = "";
  };
}
