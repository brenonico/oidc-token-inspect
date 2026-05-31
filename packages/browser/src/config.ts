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
