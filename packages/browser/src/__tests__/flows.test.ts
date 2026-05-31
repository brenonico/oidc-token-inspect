import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTraceSource } from "@oidc-token-inspect/core";
import type { FlowRun, TraceJournal } from "@oidc-token-inspect/core";
import { installObserver } from "../observer";
import type { TokenInspectConfig } from "../config";
import { defaultConfig } from "../config";

const ISSUER = "https://idp.example.test/realms/demo";
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;

function cfg(over: Partial<TokenInspectConfig> = {}): TokenInspectConfig {
  return {
    ...defaultConfig,
    enabled: true,
    capabilities: { ...defaultConfig.capabilities, clientObserver: true },
    idp: { issuer: ISSUER },
    ...over,
  };
}

/** Minimal unsigned JWT with the given payload (header.payload.sig). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

let originalFetch: typeof window.fetch;

beforeEach(() => {
  originalFetch = window.fetch;
  sessionStorage.clear();
  history.replaceState({}, "", "/");
});

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

function runs(live: LiveTraceSource): FlowRun[] {
  return (live.getJournal() as TraceJournal).runs;
}

describe("ClientObserver — auth.implicit reconstruction", () => {
  it("reconstructs an auth.implicit run from a token in the URL fragment", () => {
    const live = new LiveTraceSource();
    const accessToken = jwt({ sub: "user-2", scope: "openid", iss: ISSUER });

    const teardown = installObserver(live, cfg());

    // The IdP redirects back with the token in the FRAGMENT (no ?code=).
    history.pushState({}, "", `/cb#access_token=${accessToken}&token_type=Bearer&state=S2`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    const implicit = runs(live).find((r) => r.flowKind === "auth.implicit");
    expect(implicit).toBeDefined();
    expect(implicit!.source).toBe("client");
    expect(implicit!.status).toBe("Completed");
    expect(implicit!.correlationId).toBe("S2");

    const fragment = implicit!.steps.find((s) => s.label === "Token in fragment")!;
    expect(fragment).toBeDefined();
    expect(fragment.source).toBe("client");
    expect(typeof fragment.seq).toBe("number");
    // The access_token is decoded into a Jwt var + claim vars.
    expect(fragment.vars.some((v) => v.name === "access_token" && v.kind === "Jwt")).toBe(true);
    expect(fragment.vars.some((v) => v.name === "access_token_claims")).toBe(true);
    expect(fragment.vars.find((v) => v.name === "token_type")?.value).toBe("Bearer");
    expect(fragment.vars.find((v) => v.name === "state")?.value).toBe("S2");

    // No storage observer feeding writes → no "Storage write" step.
    expect(implicit!.steps.some((s) => s.label === "Storage write")).toBe(false);

    teardown();
  });

  it("generates a correlation id when the fragment carries no state", () => {
    const live = new LiveTraceSource();
    const idToken = jwt({ sub: "user-3", name: "Grace" });

    const teardown = installObserver(live, cfg());

    history.pushState({}, "", `/cb#id_token=${idToken}&token_type=Bearer`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    const implicit = runs(live).find((r) => r.flowKind === "auth.implicit");
    expect(implicit).toBeDefined();
    expect(implicit!.correlationId).toBeTruthy();
    expect(implicit!.steps.find((s) => s.label === "Token in fragment")!.vars
      .some((v) => v.name === "id_token" && v.kind === "Jwt")).toBe(true);

    teardown();
  });
});

describe("ClientObserver — auth.ropc reconstruction", () => {
  it("reconstructs an auth.ropc run and REDACTS the password", async () => {
    const live = new LiveTraceSource();
    const accessToken = jwt({ sub: "alice", scope: "openid" });

    window.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg());

    await window.fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: "alice",
        password: "secret",
        scope: "openid",
      }).toString(),
    });
    await new Promise((r) => setTimeout(r, 0));

    const ropc = runs(live).find((r) => r.flowKind === "auth.ropc");
    expect(ropc).toBeDefined();
    expect(ropc!.source).toBe("client");
    expect(ropc!.status).toBe("Completed");

    const request = ropc!.steps.find((s) => s.label === "Password grant request")!;
    expect(request).toBeDefined();
    // username shown in the clear.
    expect(request.vars.find((v) => v.name === "username")?.value).toBe("alice");
    // grant_type / scope present.
    expect(request.vars.find((v) => v.name === "grant_type")?.value).toBe("password");
    expect(request.vars.find((v) => v.name === "scope")?.value).toBe("openid");

    // password REDACTED: redacted flag true AND the value is NOT the real secret.
    const password = request.vars.find((v) => v.name === "password")!;
    expect(password).toBeDefined();
    expect(password.redacted).toBe(true);
    expect(password.value).not.toBe("secret");

    // The whole journal NEVER contains the raw password anywhere.
    expect(JSON.stringify(runs(live))).not.toContain("secret");

    // Tokens received completes the flow.
    const tokens = ropc!.steps.find((s) => s.label === "Tokens received")!;
    expect(tokens).toBeDefined();
    expect(tokens.vars.some((v) => v.name === "access_token" && v.kind === "Jwt")).toBe(true);

    teardown();
  });

  it("redacts the password even when redaction is 'didactic'", async () => {
    const live = new LiveTraceSource();
    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: jwt({ sub: "bob" }) }), { status: 200 }),
    ) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg({ redaction: "didactic" }));

    await window.fetch(TOKEN_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        username: "bob",
        password: "hunter2",
      }).toString(),
    });
    await new Promise((r) => setTimeout(r, 0));

    const ropc = runs(live).find((r) => r.flowKind === "auth.ropc")!;
    const password = ropc.steps
      .find((s) => s.label === "Password grant request")!
      .vars.find((v) => v.name === "password")!;
    // Even in didactic mode the raw user password is never exposed.
    expect(password.redacted).toBe(true);
    expect(password.value).not.toBe("hunter2");
    expect(JSON.stringify(runs(live))).not.toContain("hunter2");

    teardown();
  });
});

describe("ClientObserver — auth.refresh reconstruction", () => {
  it("reconstructs an auth.refresh run with rotated tokens", async () => {
    const live = new LiveTraceSource();
    const newAccess = jwt({ sub: "user-4", scope: "openid" });
    const newId = jwt({ sub: "user-4", name: "Lin" });

    window.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: newAccess,
          id_token: newId,
          refresh_token: "RT-NEW-456",
          token_type: "Bearer",
          expires_in: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg());

    await window.fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "RT123",
      }).toString(),
    });
    await new Promise((r) => setTimeout(r, 0));

    const refresh = runs(live).find((r) => r.flowKind === "auth.refresh");
    expect(refresh).toBeDefined();
    expect(refresh!.source).toBe("client");
    expect(refresh!.status).toBe("Completed");

    const grant = refresh!.steps.find((s) => s.label === "Refresh grant")!;
    expect(grant).toBeDefined();
    expect(grant.vars.find((v) => v.name === "grant_type")?.value).toBe("refresh_token");
    // The old refresh_token is present as a redacted/opaque var (not in the clear).
    const oldRt = grant.vars.find((v) => v.name === "refresh_token");
    expect(oldRt).toBeDefined();

    const rotated = refresh!.steps.find((s) => s.label === "New tokens (rotated)")!;
    expect(rotated).toBeDefined();
    expect(rotated.vars.some((v) => v.name === "access_token" && v.kind === "Jwt")).toBe(true);
    // A new refresh_token in the response is noted as rotation.
    expect(rotated.vars.find((v) => v.name === "rotation")?.value).toContain("new refresh_token");

    teardown();
  });
});
