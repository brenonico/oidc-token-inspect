import type { FlowRun, TraceJournal, TraceOrigin } from "./schema";
import type { TraceSource } from "./TraceSource";

/**
 * Fixed source ordering for deterministic, LOGICAL merge (never wall-clock).
 * A step from "client" always precedes a step from "server", which precedes "bff".
 * "merged" is only ever produced by this module, so it sorts last as a safety net.
 */
const SOURCE_ORDER: Record<TraceOrigin, number> = {
  client: 0,
  server: 1,
  bff: 2,
  merged: 3,
};

function sourceRank(origin: TraceOrigin | undefined): number {
  if (origin === undefined) return Number.MAX_SAFE_INTEGER;
  return SOURCE_ORDER[origin];
}

/**
 * Merge runs that share a correlationId into a single run.
 *
 * - Runs WITHOUT a correlationId, or with a unique one, are returned unchanged
 *   (order preserved).
 * - Runs sharing a correlationId are folded into one run with source "merged",
 *   steps concatenated and ordered by (source rank, then seq). Each step keeps
 *   its own `source`.
 * - When more than two DISTINCT sources share one correlationId, `fanOut` is set
 *   on the merged run (didactic warning) and nothing is hidden.
 */
export function mergeByCorrelation(runs: FlowRun[]): FlowRun[] {
  const groups = new Map<string, FlowRun[]>();
  const order: string[] = [];

  for (const run of runs) {
    // No correlationId → always independent. Use a unique synthetic key.
    const key = run.correlationId ?? `__solo__:${order.length}:${run.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(run);
  }

  const out: FlowRun[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    out.push(mergeGroup(group));
  }
  return out;
}

function mergeGroup(group: FlowRun[]): FlowRun {
  const base = group[0];

  const distinctSources = new Set<TraceOrigin>();
  for (const run of group) {
    if (run.source !== undefined) distinctSources.add(run.source);
  }

  const steps = group
    .flatMap((run) => run.steps)
    .slice()
    .sort((a, b) => {
      const rankDiff = sourceRank(a.source) - sourceRank(b.source);
      if (rankDiff !== 0) return rankDiff;
      const seqA = a.seq ?? a.ordinal;
      const seqB = b.seq ?? b.ordinal;
      return seqA - seqB;
    });

  const participants = Array.from(new Set(group.flatMap((run) => run.participants)));

  const ended = group
    .map((run) => run.endedAt)
    .filter((v): v is string => typeof v === "string");
  const error = group.map((run) => run.error).find((v) => typeof v === "string" && v.length > 0);

  const status: FlowRun["status"] = group.some((r) => r.status === "Failed")
    ? "Failed"
    : group.every((r) => r.status === "Completed")
      ? "Completed"
      : "Running";

  const merged: FlowRun = {
    id: base.id,
    flowKind: base.flowKind,
    title: base.title,
    status,
    startedAt: base.startedAt,
    endedAt: ended.length > 0 ? ended.sort().slice(-1)[0] : null,
    error: error ?? null,
    participants,
    steps,
    correlationId: base.correlationId,
    source: "merged",
  };

  if (distinctSources.size > 2) merged.fanOut = true;

  return merged;
}

/**
 * Composite TraceSource that fans in several sources and exposes a single merged
 * journal, correlating runs by correlationId with logical ordering.
 */
export class CompositeTraceSource implements TraceSource {
  private journal: TraceJournal = { runs: [] };
  private readonly subs = new Set<(j: TraceJournal) => void>();
  private readonly latest = new Map<TraceSource, TraceJournal>();
  private unsubs: Array<() => void> = [];
  private wired = false;

  constructor(private readonly sources: TraceSource[]) {}

  getJournal(): TraceJournal {
    return this.journal;
  }

  subscribe(cb: (j: TraceJournal) => void): () => void {
    this.subs.add(cb);
    this.ensureWired();
    cb(this.journal);

    return () => {
      this.subs.delete(cb);
      if (this.subs.size === 0) this.teardown();
    };
  }

  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.unsubs = this.sources.map((source) =>
      source.subscribe((j) => {
        this.latest.set(source, j);
        this.recompute();
      }),
    );
  }

  private teardown(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore unsubscribe errors
      }
    }
    this.unsubs = [];
    this.latest.clear();
    this.wired = false;
  }

  private recompute(): void {
    const sessionId = this.sources
      .map((s) => this.latest.get(s)?.sessionId)
      .find((v) => typeof v === "string" && v.length > 0);

    const allRuns: FlowRun[] = [];
    for (const source of this.sources) {
      const j = this.latest.get(source);
      if (j) allRuns.push(...j.runs);
    }

    this.journal = { sessionId, runs: mergeByCorrelation(allRuns) };
    this.emit();
  }

  private emit(): void {
    for (const cb of this.subs) {
      try {
        cb(this.journal);
      } catch {
        // a faulty subscriber must not break the fan-out to the others
      }
    }
  }
}
