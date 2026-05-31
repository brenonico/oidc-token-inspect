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
  // Reset URL to a clean base before each test.
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

describe("ClientObserver — PKCE auth.login reconstruction", () => {
  it("reconstructs an auth.login run keyed by state through the full flow", async () => {
    const live = new LiveTraceSource();

    // Seed PKCE artifacts the app stored before redirecting to the IdP.
    sessionStorage.setItem("state", "S1");
    sessionStorage.setItem("code_verifier", "the-verifier-value-1234567890");

    // The token endpoint returns JWTs; mock the ORIGINAL fetch.
    const accessToken = jwt({ sub: "user-1", scope: "openid", iss: ISSUER });
    const idToken = jwt({ sub: "user-1", name: "Ada", aud: "spa" });
    window.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: accessToken, id_token: idToken, token_type: "Bearer", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg());

    // 1) The IdP redirects back with ?code=XYZ&state=S1.
    history.pushState({}, "", "/cb?code=XYZ&state=S1");
    window.dispatchEvent(new PopStateEvent("popstate"));

    // 2) The app POSTs the code to the token endpoint to exchange for tokens.
    await window.fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "XYZ",
        code_verifier: "the-verifier-value-1234567890",
        redirect_uri: "https://app.example.test/cb",
        client_id: "spa",
      }).toString(),
    });

    // Flush the .then() microtasks (fetch wrap + async readTokenJson).
    await new Promise((r) => setTimeout(r, 0));

    const all = runs(live);
    const login = all.find((r) => r.flowKind === "auth.login");
    expect(login).toBeDefined();
    expect(login!.correlationId).toBe("S1");
    expect(login!.source).toBe("client");
    expect(login!.status).toBe("Completed");

    const labels = login!.steps.map((s) => s.label);
    expect(labels).toContain("Generated PKCE pair");
    expect(labels).toContain("Authorization code received");
    expect(labels).toContain("Exchange code for tokens");
    expect(labels).toContain("Tokens received");

    // The PKCE step exposes state + the verifier read from sessionStorage.
    const pkce = login!.steps.find((s) => s.label === "Generated PKCE pair")!;
    expect(pkce.vars.find((v) => v.name === "state")?.value).toBe("S1");
    expect(pkce.vars.some((v) => v.name === "code_verifier")).toBe(true);

    // Tokens step decodes JWTs into claim vars.
    const tokens = login!.steps.find((s) => s.label === "Tokens received")!;
    expect(tokens.vars.some((v) => v.name === "access_token" && v.kind === "Jwt")).toBe(true);
    expect(tokens.vars.some((v) => v.name === "access_token_claims")).toBe(true);

    // Every step is tagged to the client lane with a per-source seq.
    expect(login!.steps.every((s) => s.source === "client")).toBe(true);
    expect(login!.steps.every((s) => typeof s.seq === "number")).toBe(true);

    teardown();
  });
});

describe("ClientObserver — api.call reconstruction", () => {
  it("creates an api.call run for a Bearer-carrying fetch to a non-IdP host", async () => {
    const live = new LiveTraceSource();
    const bearer = jwt({ sub: "user-1", scope: "loans:read" });

    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg());

    await window.fetch("https://api.example.test/loans", {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
    });
    await new Promise((r) => setTimeout(r, 0));

    const api = runs(live).find((r) => r.flowKind === "api.call");
    expect(api).toBeDefined();
    expect(api!.source).toBe("client");
    expect(api!.steps.map((s) => s.label)).toEqual(["Request", "Response"]);
    const reqStep = api!.steps[0];
    expect(reqStep.vars.find((v) => v.name === "url")?.value).toBe("https://api.example.test/loans");
    expect(reqStep.vars.some((v) => v.name === "bearer_claims")).toBe(true);
    const resStep = api!.steps[1];
    expect(resStep.vars.find((v) => v.name === "status")?.value).toBe("200");

    teardown();
  });

  it("does NOT create an api.call run for requests to the IdP host", async () => {
    const live = new LiveTraceSource();
    window.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof window.fetch;

    const teardown = installObserver(live, cfg());

    // A Bearer-carrying request to the IdP itself must not be an api.call.
    await window.fetch(`${ISSUER}/protocol/openid-connect/userinfo`, {
      headers: { authorization: "Bearer x" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(runs(live).filter((r) => r.flowKind === "api.call")).toHaveLength(0);
    teardown();
  });
});

describe("ClientObserver — teardown", () => {
  it("restores window.fetch and XMLHttpRequest prototype methods", () => {
    const live = new LiveTraceSource();
    const fetchRef = window.fetch;
    const openRef = XMLHttpRequest.prototype.open;
    const sendRef = XMLHttpRequest.prototype.send;
    const setHeaderRef = XMLHttpRequest.prototype.setRequestHeader;

    const teardown = installObserver(live, cfg());
    expect(window.fetch).not.toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).not.toBe(openRef);

    teardown();
    expect(window.fetch).toBe(fetchRef);
    expect(XMLHttpRequest.prototype.open).toBe(openRef);
    expect(XMLHttpRequest.prototype.send).toBe(sendRef);
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(setHeaderRef);
  });
});
