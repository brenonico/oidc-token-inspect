// Main component
export { TokenInspectPanel } from "./TokenInspectPanel";
export type { TokenInspectPanelProps } from "./TokenInspectPanel";

// Hooks
export { useTokenInspect } from "./useTokenInspect";
export type { UseTokenInspectOptions, UseTokenInspectResult, TokenInspectClient } from "./useTokenInspect";
export { useTheme } from "./useTheme";
export type { ThemeMode, UseThemeResult } from "./useTheme";

// Schema types (sourced transitively from @token-inspect/core)
export type {
  VariableKind,
  FlowStatus,
  TraceVariable,
  TraceStep,
  FlowRun,
  TraceJournal,
} from "./trace-schema";

// Source API (re-exported from @token-inspect/core)
export { HttpTraceSource, LiveTraceSource, CompositeTraceSource } from "@token-inspect/core";
export type { TraceSource } from "@token-inspect/core";

// Utilities
export { decodeJwt, shortPreview } from "./decode";
export type { DecodedJwt } from "./decode";

// Sub-components (for advanced composition)
export { SequenceDiagram } from "./SequenceDiagram";
export { VariableCard } from "./VariableCard";
export { VariableModal } from "./VariableModal";
export { SnippetView } from "./snippet";
