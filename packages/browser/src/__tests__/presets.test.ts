import { afterEach, describe, expect, it } from "vitest";
import { applyPreset, deepMerge, presets } from "../presets";
import { defaultConfig } from "../config";
import { resolveConfig, init, teardown } from "../index";
import { findIdpFromTraffic, findTokensInStorage, labelLaneByHost } from "../observer/autodetect";

afterEach(() => {
  teardown();
});

// A real, decodable JWT (alg HS256, payload {sub:"1234567890",name:"t"}). The
// signature segment is irrelevant — decodeJwt only reads header+payload.
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6InQifQ." +
  "sig";

describe("presets — documented capability defaults", () => {
  it('"public-client-spa" enables clientObserver + storageScan, correlation stays off', () => {
    const cfg = presets["public-client-spa"](defaultConfig);
    expect(cfg.capabilities.clientObserver).toBe(true);
    expect(cfg.capabilities.storageScan).toBe(true);
    expect(cfg.capabilities.correlation.enabled).toBe(false);
  });

  it('"bff-sessionmanager" keeps clientObserver off (panel only; server records)', () => {
    const cfg = presets["bff-sessionmanager"](defaultConfig);
    expect(cfg.capabilities.clientObserver).toBe(false);
    expect(cfg.capabilities.storageScan).toBe(false);
    expect(cfg.capabilities.correlation.enabled).toBe(false);
  });

  it('"api-validates-token" enables clientObserver + correlation with allowlist ["self"]', () => {
    const cfg = presets["api-validates-token"](defaultConfig);
    expect(cfg.capabilities.clientObserver).toBe(true);
    expect(cfg.capabilities.correlation.enabled).toBe(true);
    expect(cfg.capabilities.correlation.allowlist).toEqual(["self"]);
  });

  it('"public-client-spa" does NOT enable correlation; "api-validates-token" DOES', () => {
    expect(presets["public-client-spa"](defaultConfig).capabilities.correlation.enabled).toBe(false);
    expect(presets["api-validates-token"](defaultConfig).capabilities.correlation.enabled).toBe(true);
  });
});

describe("precedence — defaultConfig < preset < user (user always wins)", () => {
  it("user explicit false overrides a preset true (storageScan)", () => {
    const cfg = resolveConfig({
      preset: "public-client-spa",
      capabilities: { storageScan: false },
    });
    // preset turned storageScan ON, user turned it back OFF → user wins.
    expect(cfg.capabilities.storageScan).toBe(false);
    // sibling preset value is untouched.
    expect(cfg.capabilities.clientObserver).toBe(true);
  });

  it("user explicit true overrides a preset false (clientObserver under bff-sessionmanager)", () => {
    const cfg = resolveConfig({
      preset: "bff-sessionmanager",
      capabilities: { clientObserver: true },
    });
    expect(cfg.capabilities.clientObserver).toBe(true);
  });

  it("a preset never turns OFF something the user explicitly turned on", () => {
    // bff-sessionmanager patch sets clientObserver:false, but user said true.
    const cfg = applyPreset(defaultConfig, "bff-sessionmanager", {
      capabilities: { clientObserver: true },
    });
    expect(cfg.capabilities.clientObserver).toBe(true);
  });

  it("preset value applies when the user does not set that key", () => {
    const cfg = resolveConfig({ preset: "api-validates-token" });
    expect(cfg.capabilities.correlation.enabled).toBe(true);
    expect(cfg.capabilities.correlation.allowlist).toEqual(["self"]);
    // unspecified leaf falls back to defaultConfig.
    expect(cfg.capabilities.correlation.header).toBe("traceparent");
  });

  it("resolving a config never mutates defaultConfig", () => {
    const before = JSON.stringify(defaultConfig);
    resolveConfig({ preset: "public-client-spa", capabilities: { storageScan: false } });
    expect(JSON.stringify(defaultConfig)).toBe(before);
  });

  it("no preset → plain deep-merge of user over defaults", () => {
    const cfg = resolveConfig({ redaction: "mask" });
    expect(cfg.redaction).toBe("mask");
    expect(cfg.capabilities.clientObserver).toBe(false);
  });
});

describe("deepMerge", () => {
  it("merges nested objects key-by-key and replaces arrays wholesale", () => {
    const merged = deepMerge(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
      { nested: { y: 9 }, list: [3] },
    );
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 9 }, list: [3] });
  });

  it("an absent (undefined) patch key never clobbers the base", () => {
    const merged = deepMerge({ a: 1 }, { a: undefined } as never);
    expect(merged.a).toBe(1);
  });
});

describe("preset inert-by-default invariant via init()", () => {
  it("a preset that enables clientObserver does NOT patch fetch when enabled is false", () => {
    const fetchRef = window.fetch;
    init({ preset: "public-client-spa" }); // enabled omitted → inert
    expect(window.fetch).toBe(fetchRef);
    expect(document.querySelector("[data-ti-root]")).toBeNull();
  });
});

describe("autodetect — pure helpers, never enable a capability or patch a global", () => {
  it("findTokensInStorage finds a seeded JWT and ignores non-JWT values", () => {
    const storage = window.sessionStorage;
    storage.clear();
    storage.setItem("access_token", SAMPLE_JWT);
    storage.setItem("theme", "dark");
    storage.setItem("almost.jwt", "a.b"); // wrong segment count / not decodable

    const found = findTokensInStorage(storage);
    expect(found).toEqual([{ key: "access_token", value: SAMPLE_JWT }]);
    storage.clear();
  });

  it("findTokensInStorage returns [] for null/empty storage", () => {
    expect(findTokensInStorage(null)).toEqual([]);
  });

  it("findIdpFromTraffic infers the issuer origin from observed OIDC URLs", () => {
    const origin = findIdpFromTraffic([
      "https://app.example.test/api/data",
      "https://id.example.test/realms/x/protocol/openid-connect/token",
    ]);
    expect(origin).toBe("https://id.example.test");
  });

  it("findIdpFromTraffic returns undefined when no OIDC-shaped URL is present", () => {
    expect(findIdpFromTraffic(["https://app.example.test/api/data"])).toBeUndefined();
  });

  it("labelLaneByHost maps a URL host to a configured lane label", () => {
    const apis = [{ match: "core.example.test", lane: "Core API" }];
    expect(labelLaneByHost("https://core.example.test/v1/x", apis)).toBe("Core API");
    expect(labelLaneByHost("https://other.example.test/v1/x", apis)).toBeUndefined();
    expect(labelLaneByHost("https://x.test/y", undefined)).toBeUndefined();
  });

  it("autodetect never flips a capability or patches a global (window.fetch unchanged)", () => {
    const fetchRef = window.fetch;
    const openRef = XMLHttpRequest.prototype.open;

    // A bff-sessionmanager preset leaves clientObserver:false → no patching.
    const cfg = resolveConfig({ enabled: true, preset: "bff-sessionmanager", ackExposesTokens: true });
    expect(cfg.capabilities.clientObserver).toBe(false);

    // Calling the autodetect helpers must not patch anything either.
    findIdpFromTraffic(["https://id.example.test/oauth2/token"]);
    findTokensInStorage(window.sessionStorage);
    labelLaneByHost("https://x.test/y", cfg.apis);

    expect(window.fetch).toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).toBe(openRef);
  });
});
