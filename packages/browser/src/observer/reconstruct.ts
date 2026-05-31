import type { FlowRun, LiveTraceSource, TraceStep, TraceVariable } from "@oidc-token-inspect/core";
import { decodeJwt } from "@oidc-token-inspect/core";
import type { TokenInspectConfig } from "../config";
import type { NetEvent } from "./types";
import type { RedirectCallback } from "./redirect";
import { isIdpHost, isIdpTokenEndpoint } from "./idp";

/**
 * State machine that turns observed network/redirect events into FlowRuns:
 *
 *  - `auth.login` (Authorization Code + PKCE), keyed by the OAuth `state` which
 *    doubles as the run's `correlationId`.
 *  - `auth.implicit`, when the redirect callback carries the token in the URL
 *    fragment (`#access_token=…` / `#id_token=…`), keyed by `state` if present.
 *  - `auth.ropc`, when a token-endpoint POST uses `grant_type=password`.
 *  - `auth.refresh`, when a token-endpoint POST uses `grant_type=refresh_token`.
 *  - `api.call`, one run per Bearer-carrying request to a NON-IdP host.
 *
 * Runs are fed to the LiveTraceSource via `upsertRun` (idempotent by id) so the
 * same run id is enriched step-by-step as the flow progresses.
 */
export class Reconstructor {
  /** auth.login runs keyed by OAuth state. */
  private readonly authRuns = new Map<string, FlowRun>();
  /** auth.implicit runs keyed by correlation id (state or a generated id). */
  private readonly implicitRuns = new Map<string, FlowRun>();
  /** One-shot auth.ropc / auth.refresh runs keyed by their generated id. */
  private readonly grantRuns = new Map<string, FlowRun>();
  /** Per-source monotonically increasing step seq (client lane). */
  private seq = 0;
  /** Per-run step ordinal counters. */
  private readonly ordinals = new Map<string, number>();
  private apiCounter = 0;
  private implicitCounter = 0;
  private ropcCounter = 0;
  private refreshCounter = 0;
  /**
   * Tokens observed written to storage (by the OPT-IN storageScan observer).
   * The implicit flow's "Storage write" step is emitted ONLY when a matching
   * token value is present here — i.e. only if the storage observer is active.
   * Empty (and so the step is never emitted) until something feeds it.
   */
  private readonly storageWrites = new Set<string>();

  constructor(
    private readonly live: LiveTraceSource,
    private readonly config: TokenInspectConfig,
  ) {}

  /**
   * Record a token value seen written to storage by the (separately opt-in)
   * storage observer. Used to gate the implicit flow's "Storage write" step so
   * it only appears when the storage observer is active/visible.
   */
  noteStorageWrite(value: string): void {
    if (value) this.storageWrites.add(value);
  }

  // ── auth.login ─────────────────────────────────────────────────────────────

  /** Ensure an auth.login run exists for `state` and record the PKCE generation step. */
  beginAuthLogin(state: string): FlowRun {
    let run = this.authRuns.get(state);
    if (run) return run;

    run = {
      id: `auth.login:${state}`,
      flowKind: "auth.login",
      title: "Authorization Code + PKCE",
      status: "Running",
      startedAt: new Date().toISOString(),
      participants: ["Browser", "IdP"],
      steps: [],
      correlationId: state,
      source: "client",
    };
    this.authRuns.set(state, run);

    const vars: TraceVariable[] = [{ name: "state", kind: "Plain", value: state }];
    const verifier = readSession("code_verifier") ?? readSession(`pkce_code_verifier_${state}`);
    if (verifier) vars.push(redact({ name: "code_verifier", kind: "Opaque", value: verifier }, this.config));
    const challenge = readSession("code_challenge");
    if (challenge) vars.push({ name: "code_challenge", kind: "Hash", value: challenge });

    this.addStep(run, {
      label: "Generated PKCE pair",
      short: "PKCE",
      from: "Browser",
      to: "Browser",
      vars,
    });
    this.flush(run);
    return run;
  }

  /** Record the `?code=` redirect callback step on the matching auth.login run. */
  onAuthorizationCode(state: string, code: string): void {
    const run = this.beginAuthLogin(state);
    this.addStep(run, {
      label: "Authorization code received",
      short: "code",
      from: "IdP",
      to: "Browser",
      vars: [redact({ name: "code", kind: "Code", value: code }, this.config)],
    });
    this.flush(run);
  }

  /** Record the token-endpoint POST (code → tokens exchange request). */
  onTokenExchangeRequest(state: string, params: Record<string, string>): void {
    const run = this.beginAuthLogin(state);
    const vars: TraceVariable[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (k === "code" || k === "code_verifier" || k === "client_secret" || k === "refresh_token") {
        vars.push(redact({ name: k, kind: k === "code" ? "Code" : "Opaque", value: v }, this.config));
      } else {
        vars.push({ name: k, kind: "Plain", value: v });
      }
    }
    this.addStep(run, {
      label: "Exchange code for tokens",
      short: "exchange",
      from: "Browser",
      to: "IdP",
      vars,
    });
    this.flush(run);
  }

  /** Record the token response and complete the run, decoding any JWTs into vars. */
  onTokensReceived(state: string, tokenJson: Record<string, unknown>): void {
    const run = this.beginAuthLogin(state);
    const vars: TraceVariable[] = [];
    pushTokenVars(vars, tokenJson, this.config);

    this.addStep(run, {
      label: "Tokens received",
      short: "tokens",
      from: "IdP",
      to: "Browser",
      vars,
    });
    run.status = "Completed";
    run.endedAt = new Date().toISOString();
    this.flush(run);
  }

  // ── auth.implicit ──────────────────────────────────────────────────────────

  /**
   * Reconstruct an Implicit-grant run from a redirect callback whose URL
   * FRAGMENT carries the token(s). Correlated by `state` when present, else a
   * generated id. Decodes the access_token / id_token into vars, and emits a
   * "Storage write" step only when a matching token was observed written to
   * storage (i.e. the opt-in storage observer is active). Completes the run.
   */
  onImplicitCallback(cb: { accessToken?: string; idToken?: string; tokenType?: string; state?: string }): void {
    const correlationId = cb.state || `implicit-${++this.implicitCounter}`;
    let run = this.implicitRuns.get(correlationId);
    if (run) return; // idempotent: a re-emit of the same fragment must not duplicate

    run = {
      id: `auth.implicit:${correlationId}`,
      flowKind: "auth.implicit",
      title: "Implicit grant",
      status: "Running",
      startedAt: new Date().toISOString(),
      participants: ["Browser", "IdP"],
      steps: [],
      correlationId,
      source: "client",
    };
    this.implicitRuns.set(correlationId, run);

    const vars: TraceVariable[] = [];
    if (cb.state) vars.push({ name: "state", kind: "Plain", value: cb.state });
    for (const [name, value] of [
      ["access_token", cb.accessToken],
      ["id_token", cb.idToken],
    ] as const) {
      if (typeof value !== "string" || !value) continue;
      const decoded = decodeJwt(value);
      if (decoded) {
        vars.push(redact({ name, kind: "Jwt", value }, this.config));
        vars.push({ name: `${name}_claims`, kind: "Json", value: JSON.stringify(decoded.payload, null, 2) });
      } else {
        vars.push(redact({ name, kind: "Opaque", value }, this.config));
      }
    }
    if (cb.tokenType) vars.push({ name: "token_type", kind: "Plain", value: cb.tokenType });

    this.addStep(run, {
      label: "Token in fragment",
      short: "fragment",
      from: "IdP",
      to: "Browser",
      vars,
    });

    // "Storage write" — ONLY when a token from this callback was observed
    // written to storage (the storage observer is opt-in/separately enabled).
    const written = [cb.accessToken, cb.idToken].filter(
      (v): v is string => typeof v === "string" && v.length > 0 && this.storageWrites.has(v),
    );
    if (written.length > 0) {
      const storageVars: TraceVariable[] = written.map((v) => {
        const name = v === cb.accessToken ? "access_token" : "id_token";
        return redact({ name, kind: decodeJwt(v) ? "Jwt" : "Opaque", value: v }, this.config);
      });
      this.addStep(run, {
        label: "Storage write",
        short: "storage",
        from: "Browser",
        to: "Browser",
        vars: storageVars,
      });
    }

    run.status = "Completed";
    run.endedAt = new Date().toISOString();
    this.flush(run);
  }

  // ── auth.ropc ──────────────────────────────────────────────────────────────

  /**
   * Begin a Resource Owner Password Credentials run on a token POST with
   * `grant_type=password`. The username is shown but the password is ALWAYS
   * redacted (never stored raw) regardless of the `redaction` config — a raw
   * user password is more sensitive than a token. Returns the run id used to
   * correlate the eventual "Tokens received" step.
   */
  onRopcRequest(params: Record<string, string>): string {
    const id = `auth.ropc:${++this.ropcCounter}`;
    const run: FlowRun = {
      id,
      flowKind: "auth.ropc",
      title: "Resource Owner Password Credentials",
      status: "Running",
      startedAt: new Date().toISOString(),
      participants: ["Browser", "IdP"],
      steps: [],
      correlationId: id,
      source: "client",
    };
    this.grantRuns.set(id, run);

    const vars: TraceVariable[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (k === "password") {
        // ALWAYS redacted — the raw password is NEVER put in the journal.
        vars.push({ name: "password", kind: "Opaque", value: PASSWORD_MASK, redacted: true });
      } else if (k === "client_secret") {
        vars.push(redact({ name: k, kind: "Opaque", value: v }, this.config));
      } else {
        vars.push({ name: k, kind: "Plain", value: v });
      }
    }

    this.addStep(run, {
      label: "Password grant request",
      short: "password",
      from: "Browser",
      to: "IdP",
      vars,
    });
    this.flush(run);
    return id;
  }

  // ── auth.refresh ───────────────────────────────────────────────────────────

  /**
   * Begin a Refresh-token run on a token POST with `grant_type=refresh_token`.
   * The refresh_token is shown as an Opaque/redacted var. Returns the run id.
   */
  onRefreshRequest(params: Record<string, string>): string {
    const id = `auth.refresh:${++this.refreshCounter}`;
    const run: FlowRun = {
      id,
      flowKind: "auth.refresh",
      title: "Refresh token grant",
      status: "Running",
      startedAt: new Date().toISOString(),
      participants: ["Browser", "IdP"],
      steps: [],
      correlationId: id,
      source: "client",
    };
    this.grantRuns.set(id, run);

    const vars: TraceVariable[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (k === "refresh_token" || k === "client_secret") {
        vars.push(redact({ name: k, kind: "Opaque", value: v }, this.config));
      } else {
        vars.push({ name: k, kind: "Plain", value: v });
      }
    }

    this.addStep(run, {
      label: "Refresh grant",
      short: "refresh",
      from: "Browser",
      to: "IdP",
      vars,
    });
    this.flush(run);
    return id;
  }

  /**
   * Complete a ropc/refresh run with the token response. For `auth.refresh` the
   * step notes rotation when the response carries a NEW refresh_token. Decodes
   * the access_token / id_token JWTs into claim vars.
   */
  onGrantTokensReceived(runId: string, flowKind: "auth.ropc" | "auth.refresh", tokenJson: Record<string, unknown>): void {
    const run = this.grantRuns.get(runId);
    if (!run) return;

    const vars: TraceVariable[] = [];
    pushTokenVars(vars, tokenJson, this.config);

    let label = "Tokens received";
    if (flowKind === "auth.refresh") {
      label = "New tokens (rotated)";
      const rotated = typeof tokenJson.refresh_token === "string";
      vars.push({ name: "rotation", kind: "Plain", value: rotated ? "new refresh_token issued" : "refresh_token reused" });
    }

    this.addStep(run, {
      label,
      short: flowKind === "auth.refresh" ? "rotated" : "tokens",
      from: "IdP",
      to: "Browser",
      vars,
    });
    run.status = "Completed";
    run.endedAt = new Date().toISOString();
    this.flush(run);
  }

  // ── api.call ───────────────────────────────────────────────────────────────

  /** Build a one-shot api.call run for a Bearer-carrying request to a non-IdP host. */
  onApiCall(event: NetEvent, bearer: string): void {
    const id = `api.call:${++this.apiCounter}`;
    const run: FlowRun = {
      id,
      flowKind: "api.call",
      title: `${event.req.method} ${shortUrl(event.req.url)}`,
      status: event.res.status >= 400 ? "Failed" : "Completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      participants: ["Browser", "API"],
      steps: [],
      source: "client",
    };

    const reqVars: TraceVariable[] = [
      { name: "method", kind: "Plain", value: event.req.method },
      { name: "url", kind: "Url", value: event.req.url },
    ];
    const decoded = decodeJwt(bearer);
    if (decoded) {
      reqVars.push(redact({ name: "access_token", kind: "Jwt", value: bearer }, this.config));
      reqVars.push({ name: "bearer_claims", kind: "Json", value: JSON.stringify(decoded.payload, null, 2) });
    } else {
      reqVars.push(redact({ name: "bearer", kind: "Opaque", value: bearer }, this.config));
    }
    this.addStep(run, { label: "Request", short: "req", from: "Browser", to: "API", vars: reqVars });
    this.addStep(run, {
      label: "Response",
      short: "res",
      from: "API",
      to: "Browser",
      vars: [{ name: "status", kind: "Plain", value: String(event.res.status) }],
    });
    this.flush(run);
  }

  // ── event entry points ─────────────────────────────────────────────────────

  /** Handle a redirect callback (initial scan, popstate, hashchange). */
  handleRedirect(cb: RedirectCallback): void {
    // A fragment carrying a token (and no `code`) is an Implicit-grant response.
    if (!cb.code && (cb.accessToken || cb.idToken)) {
      this.onImplicitCallback({
        accessToken: cb.accessToken,
        idToken: cb.idToken,
        tokenType: cb.tokenType,
        state: cb.state,
      });
      return;
    }
    if (cb.state && cb.code) {
      this.onAuthorizationCode(cb.state, cb.code);
    } else if (cb.state) {
      // Authorize redirect with a state but no code yet (e.g. begin marker).
      this.beginAuthLogin(cb.state);
    }
  }

  /** Handle a completed network event (fetch or XHR). */
  handleNetEvent(event: NetEvent): void {
    void this.handleNetEventAsync(event);
  }

  private async handleNetEventAsync(event: NetEvent): Promise<void> {
    try {
      const url = event.req.url;
      // 1) Token endpoint POST? Dispatch by grant_type.
      if (event.req.method === "POST" && isIdpTokenEndpoint(url, this.config)) {
        const params = event.req.bodyParams ?? {};
        const grant = params.grant_type;

        // 1a) Resource Owner Password Credentials (grant_type=password).
        if (grant === "password") {
          const runId = this.onRopcRequest(params);
          if (event.res.status < 400 && event.res.readTokenJson) {
            const json = await event.res.readTokenJson();
            if (json) this.onGrantTokensReceived(runId, "auth.ropc", json);
          }
          return;
        }

        // 1b) Refresh token (grant_type=refresh_token).
        if (grant === "refresh_token") {
          const runId = this.onRefreshRequest(params);
          if (event.res.status < 400 && event.res.readTokenJson) {
            const json = await event.res.readTokenJson();
            if (json) this.onGrantTokensReceived(runId, "auth.refresh", json);
          }
          return;
        }

        // 1c) Authorization Code + PKCE exchange (existing auth.login path).
        const state = params.state || this.inferStateFromParams(params);
        if (grant === "authorization_code" && state) {
          this.onTokenExchangeRequest(state, params);
        }
        if (event.res.status < 400 && event.res.readTokenJson) {
          const json = await event.res.readTokenJson();
          if (json && state) this.onTokensReceived(state, json);
        }
        return;
      }
      // 2) Bearer-carrying call to a non-IdP host → api.call.
      if (!isIdpHost(url, this.config)) {
        const auth = event.req.headers["authorization"];
        if (auth && /^bearer\s+/i.test(auth)) {
          const bearer = auth.replace(/^bearer\s+/i, "").trim();
          if (bearer) this.onApiCall(event, bearer);
        }
      }
    } catch {
      /* swallow: reconstruction must never affect the host */
    }
  }

  /**
   * When the token POST body lacks `state` (common — `state` isn't part of the
   * token request), fall back to the only in-flight auth.login awaiting tokens,
   * or to the most-recently begun one.
   */
  private inferStateFromParams(_params: Record<string, string>): string | undefined {
    const pending = [...this.authRuns.values()].filter((r) => r.status === "Running");
    if (pending.length === 1) return pending[0].correlationId;
    if (pending.length > 1) return pending[pending.length - 1].correlationId;
    return undefined;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private addStep(run: FlowRun, partial: Omit<TraceStep, "ordinal" | "timestamp" | "source" | "seq">): void {
    const ordinal = (this.ordinals.get(run.id) ?? 0) + 1;
    this.ordinals.set(run.id, ordinal);
    run.steps.push({
      ordinal,
      timestamp: new Date().toISOString(),
      source: "client",
      seq: ++this.seq,
      ...partial,
    });
  }

  private flush(run: FlowRun): void {
    // Re-publish a shallow copy so subscribers see a new reference each upsert.
    this.live.upsertRun({ ...run, steps: [...run.steps] });
  }
}

// ── module-level helpers ───────────────────────────────────────────────────

/**
 * Fixed mask for a raw user password. The real value is NEVER stored on the
 * TraceVariable (a user password is more sensitive than a token), so this is a
 * constant placeholder rather than a transform of the actual secret.
 */
const PASSWORD_MASK = "••••••";

function readSession(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function pushTokenVars(vars: TraceVariable[], tokenJson: Record<string, unknown>, config: TokenInspectConfig): void {
  for (const key of ["access_token", "id_token", "refresh_token"] as const) {
    const v = tokenJson[key];
    if (typeof v !== "string") continue;
    const decoded = decodeJwt(v);
    if (decoded) {
      vars.push(redact({ name: key, kind: "Jwt", value: v }, config));
      vars.push({
        name: `${key}_claims`,
        kind: "Json",
        value: JSON.stringify(decoded.payload, null, 2),
      });
    } else {
      vars.push(redact({ name: key, kind: "Opaque", value: v }, config));
    }
  }
  if (typeof tokenJson.token_type === "string") {
    vars.push({ name: "token_type", kind: "Plain", value: tokenJson.token_type });
  }
  if (typeof tokenJson.expires_in === "number") {
    vars.push({ name: "expires_in", kind: "Plain", value: String(tokenJson.expires_in) });
  }
}

/** Apply the configured redaction policy. In "mask" mode secrets are masked. */
function redact(v: TraceVariable, config: TokenInspectConfig): TraceVariable {
  if (config.redaction === "mask") {
    return { ...v, value: maskValue(v.value), redacted: true };
  }
  // "didactic": values shown in full (the panel is opt-in and ack'd).
  return v;
}

function maskValue(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url, typeof window !== "undefined" ? window.location.href : undefined);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}
