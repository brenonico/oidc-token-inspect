export type VariableKind = "Jwt" | "Opaque" | "Code" | "Url" | "Hash" | "Plain" | "Json";
export type FlowStatus = "Running" | "Completed" | "Failed";
export type TraceOrigin = "client" | "server" | "bff" | "merged";

export interface TraceVariable {
  name: string;
  kind: VariableKind;
  value: string;
  redacted?: boolean;
}

export interface TraceStep {
  ordinal: number;
  label: string;
  /** Optional short label for the sequence-diagram row (e.g. "PKCE"). Falls back to a derived value. */
  short?: string | null;
  from: string;
  to: string;
  timestamp: string;
  vars: TraceVariable[];
  note?: string | null;
  /** Which adapter emitted this step. Never "merged" — a step always belongs to a concrete source. */
  source?: Exclude<TraceOrigin, "merged">;
  /** Logical ordinal within the originating source (used for deterministic merge ordering, not wall-clock). */
  seq?: number;
}

export interface FlowRun {
  id: string;
  flowKind: string;
  title: string;
  status: FlowStatus;
  startedAt: string;
  endedAt?: string | null;
  error?: string | null;
  participants: string[];
  steps: TraceStep[];
  /** Correlates runs emitted by different sources that describe the same logical flow. */
  correlationId?: string;
  /** Origin of this run. "merged" indicates a composite of multiple sources. */
  source?: TraceOrigin;
  /** Set when more than two distinct sources share one correlationId (didactic fan-out warning). */
  fanOut?: boolean;
}

export interface TraceJournal {
  sessionId?: string;
  runs: FlowRun[];
}
