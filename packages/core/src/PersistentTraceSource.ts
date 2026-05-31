import type { FlowRun, TraceJournal, TraceStep, TraceVariable } from "./schema";
import type { TraceSource } from "./TraceSource";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PersistentTraceSourceOptions {
  storageKey?: string;
  ttlMinutes?: number;
  persistTokens?: boolean;
  maxSizeKb?: number;
  storage?: StorageLike;
  now?: () => number;
}

interface Envelope {
  schema: number;
  savedAt: number;
  journal: TraceJournal;
}

const SCHEMA_VERSION = 1;
const DEFAULT_STORAGE_KEY = "oidc-ti:journal:v1";
const DEFAULT_TTL_MINUTES = 1440;
const DEFAULT_MAX_SIZE_KB = 500;

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function invalidArgument(message: string): Error {
  const error = new Error(message);
  error.name = "InvalidArgumentError";
  return error;
}

function resolveDefaultStorage(): StorageLike | undefined {
  try {
    return (globalThis as typeof globalThis & { localStorage?: StorageLike }).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isTokenVariable(variable: TraceVariable): boolean {
  // The schema has no dedicated "token" kind today, but a producer may emit one;
  // honour it alongside the JWT heuristic so neither path leaks a secret.
  return (variable.kind as string) === "token" || JWT_PATTERN.test(variable.value);
}

function redactVariable(variable: TraceVariable): TraceVariable {
  if (!isTokenVariable(variable)) return variable;
  return { name: variable.name, value: "[redacted]", kind: variable.kind };
}

function redactJournal(journal: TraceJournal): TraceJournal {
  return {
    sessionId: journal.sessionId,
    runs: journal.runs.map((run) => ({
      ...run,
      steps: run.steps.map((step) => ({
        ...step,
        vars: step.vars.map(redactVariable),
      })),
    })),
  };
}

/**
 * TraceSource that mirrors the journal to a Web Storage backend so it survives
 * navigations within the same origin. Tokens are stripped from the persisted
 * snapshot unless {@link PersistentTraceSourceOptions.persistTokens} is set.
 * Every storage interaction is best-effort: a failure degrades to in-memory only.
 */
export class PersistentTraceSource implements TraceSource {
  private readonly storageKey: string;
  private readonly ttlMs: number;
  private readonly persistTokens: boolean;
  private readonly maxBytes: number;
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly subs = new Set<(j: TraceJournal) => void>();

  private journal: TraceJournal = { runs: [] };

  constructor(opts: PersistentTraceSourceOptions = {}) {
    const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const maxSizeKb = opts.maxSizeKb ?? DEFAULT_MAX_SIZE_KB;
    if (ttlMinutes < 0) throw invalidArgument("PersistentTraceSource: ttlMinutes must be >= 0");
    if (maxSizeKb <= 0) throw invalidArgument("PersistentTraceSource: maxSizeKb must be > 0");

    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;
    this.ttlMs = ttlMinutes * 60_000;
    this.persistTokens = opts.persistTokens ?? false;
    this.maxBytes = maxSizeKb * 1024;
    this.storage = opts.storage ?? resolveDefaultStorage();
    this.now = opts.now ?? Date.now;

    this.restore();
  }

  async getJournal(): Promise<TraceJournal> {
    return this.snapshot();
  }

  subscribe(cb: (j: TraceJournal) => void): () => void {
    this.subs.add(cb);
    cb(this.snapshot());
    return () => {
      this.subs.delete(cb);
    };
  }

  recordRun(run: FlowRun): void {
    const idx = this.journal.runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      this.journal.runs[idx] = run;
    } else {
      this.journal.runs.push(run);
    }
    this.persist();
    this.emit();
  }

  recordStep(runId: string, step: TraceStep): void {
    const run = this.journal.runs.find((r) => r.id === runId);
    if (!run) return;
    run.steps.push(step);
    this.persist();
    this.emit();
  }

  clear(): void {
    this.journal = { sessionId: this.journal.sessionId, runs: [] };
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        // best-effort: a removeItem failure leaves stale data we cannot help
      }
    }
    this.emit();
  }

  private snapshot(): TraceJournal {
    return {
      sessionId: this.journal.sessionId,
      runs: this.journal.runs.filter((run) => !this.isExpired(run)),
    };
  }

  private isExpired(run: FlowRun): boolean {
    const started = Date.parse(run.startedAt);
    if (Number.isNaN(started)) return false;
    return this.now() - started > this.ttlMs;
  }

  private restore(): void {
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      return;
    }
    if (!raw) return;

    let envelope: Envelope | undefined;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (!envelope || envelope.schema !== SCHEMA_VERSION || !envelope.journal || !Array.isArray(envelope.journal.runs)) {
      return;
    }

    const runs = envelope.journal.runs;
    const kept = runs.filter((run) => !this.isExpired(run));
    this.journal = { sessionId: envelope.journal.sessionId, runs: kept };
    if (kept.length !== runs.length) this.persist();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      while (true) {
        const payload = this.serialize();
        if (byteLength(payload) <= this.maxBytes || this.journal.runs.length === 0) {
          this.storage.setItem(this.storageKey, payload);
          return;
        }
        this.evictOldest();
      }
    } catch {
      // quota exceeded, disabled storage, or SSR: keep the in-memory mirror only
    }
  }

  private serialize(): string {
    const journal = this.persistTokens ? this.journal : redactJournal(this.journal);
    const envelope: Envelope = { schema: SCHEMA_VERSION, savedAt: this.now(), journal };
    return JSON.stringify(envelope);
  }

  private evictOldest(): void {
    const runs = this.journal.runs;
    let oldest = 0;
    let oldestAt = Date.parse(runs[0].startedAt);
    for (let i = 1; i < runs.length; i++) {
      const at = Date.parse(runs[i].startedAt);
      if (!Number.isNaN(at) && (Number.isNaN(oldestAt) || at < oldestAt)) {
        oldest = i;
        oldestAt = at;
      }
    }
    runs.splice(oldest, 1);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const cb of this.subs) {
      try {
        cb(snapshot);
      } catch {
        // a faulty subscriber must not break the fan-out to the others
      }
    }
  }
}
