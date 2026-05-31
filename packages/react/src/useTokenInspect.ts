import { useEffect, useState } from "react";
import type { FlowRun, TraceJournal, TraceSource } from "@oidc-token-inspect/core";

/**
 * Backward-compatible client shape. The panel/AppShell historically passed a
 * `{ get(path): Promise<TraceJournal> }` adapter; it is still accepted via the
 * BWC shim that wraps it in an {@link HttpTraceSource}.
 */
export interface TokenInspectClient {
  get: (path: string) => Promise<TraceJournal>;
}

export interface UseTokenInspectOptions {
  source: TraceSource;
  open: boolean;
}

export interface UseTokenInspectResult {
  runs: FlowRun[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTokenInspect({ source, open }: UseTokenInspectOptions): UseTokenInspectResult {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    let active = true;
    const unsub = source.subscribe((j: TraceJournal) => {
      if (!active) return;
      setRuns(j.runs);
      setLoading(false);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [open, source]);

  const refresh = () => {
    Promise.resolve(source.getJournal())
      .then((j) => setRuns(j.runs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return { runs, loading, error, refresh };
}
