import type { FlowRun, TraceJournal } from "./schema";
import type { TraceSource } from "./TraceSource";

/**
 * In-memory TraceSource fed by a client-side observer. Runs are upserted by id
 * and every change is fanned out synchronously to all subscribers.
 */
export class LiveTraceSource implements TraceSource {
  private journal: TraceJournal;
  private readonly subs = new Set<(j: TraceJournal) => void>();

  constructor(sessionId?: string) {
    this.journal = { sessionId, runs: [] };
  }

  getJournal(): TraceJournal {
    return this.journal;
  }

  subscribe(cb: (j: TraceJournal) => void): () => void {
    this.subs.add(cb);
    cb(this.journal);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** Replace an existing run (matched by id) or append a new one, then emit. */
  upsertRun(run: FlowRun): void {
    const idx = this.journal.runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      this.journal.runs[idx] = run;
    } else {
      this.journal.runs.push(run);
    }
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
