/**
 * Public configuration surface for the drop-in browser distribution.
 * Mirrors the spec §6 config schema. The default is 100% inert: with this
 * config (or any config that leaves `enabled` false), `init()` does nothing.
 */
export interface TokenInspectConfig {
  enabled: boolean;
  ackExposesTokens: boolean;
  capabilities: {
    clientObserver: boolean;
    storageScan: boolean;
    correlation: { enabled: boolean; header: string; allowlist: string[] };
  };
  idp?: { issuer?: string };
  apis?: Array<{ match: string; lane: string }>;
  redaction: "didactic" | "mask";
  mount: { dock: "bottom" | "right" | "left"; shadowDom: boolean };
  egress?: { endpoint: string };
  preset?: "public-client-spa" | "bff-sessionmanager" | "api-validates-token";
  /** Optional label shown in the panel toolbar (e.g., "customer", "partner"). */
  app?: string;
  /**
   * Anonymous (pre-login) run correlation. `"auto"` generates or reads a UUID v4
   * from Web Storage and exposes it via the controller's `getLoginUrl` so the
   * host can round-trip it through the OAuth `state` parameter and stitch the
   * pre-login run to the authenticated one. A literal string pins a specific id.
   */
  anonymousRunId?: "auto" | string;
  /** Mirror the journal to Web Storage so it (and the anonymous id) survive navigations. */
  persist?: boolean;
}

export const defaultConfig: TokenInspectConfig = {
  enabled: false,
  ackExposesTokens: false,
  capabilities: {
    clientObserver: false,
    storageScan: false,
    correlation: { enabled: false, header: "traceparent", allowlist: ["self"] },
  },
  redaction: "didactic",
  mount: { dock: "bottom", shadowDom: true },
};
