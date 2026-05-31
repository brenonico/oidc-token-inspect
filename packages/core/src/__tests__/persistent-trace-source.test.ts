import { describe, it, expect } from "vitest";
import { PersistentTraceSource } from "../PersistentTraceSource";
import type { FlowRun, TraceStep, TraceVariable, VariableKind } from "../schema";

function makeStorage(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    length: 0,
    clear: () => map.clear(),
    key: () => null,
    dump: () => Object.fromEntries(map),
  };
}

const KEY = "oidc-ti:journal:v1";
const T0 = "2026-05-30T10:00:00.000Z";
const NOW = Date.parse("2026-05-30T10:05:00.000Z");

function variable(name: string, kind: VariableKind, value: string): TraceVariable {
  return { name, kind, value };
}

function step(ordinal: number, vars: TraceVariable[] = []): TraceStep {
  return { ordinal, label: `step ${ordinal}`, from: "browser", to: "idp", timestamp: T0, vars };
}

function run(id: string, startedAt: string, steps: TraceStep[] = []): FlowRun {
  return {
    id,
    flowKind: "authorization_code",
    title: `run ${id}`,
    status: "Running",
    startedAt,
    participants: ["browser", "idp"],
    steps,
  };
}

function readEnvelope(storage: { dump(): Record<string, string> }): {
  schema: number;
  savedAt: number;
  journal: { runs: FlowRun[] };
} {
  return JSON.parse(storage.dump()[KEY]);
}

describe("PersistentTraceSource", () => {
  it("RecordRun_PersistsToStorage", () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(run("r1", T0));

    const env = readEnvelope(storage);
    expect(env.schema).toBe(1);
    expect(env.savedAt).toBe(NOW);
    expect(env.journal.runs).toHaveLength(1);
    expect(env.journal.runs[0].id).toBe("r1");
  });

  it("RecordStep_AppendsToExistingRun", async () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(run("r1", T0));
    src.recordStep("r1", step(1));
    src.recordStep("r1", step(2));

    const journal = await src.getJournal();
    expect(journal.runs[0].steps.map((s) => s.ordinal)).toEqual([1, 2]);

    const env = readEnvelope(storage);
    expect(env.journal.runs[0].steps).toHaveLength(2);
  });

  it("RecordStep_OnUnknownRun_DoesNothing", () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(run("r1", T0));
    expect(() => src.recordStep("missing", step(1))).not.toThrow();
    expect(readEnvelope(storage).journal.runs[0].steps).toHaveLength(0);
  });

  it("GetJournal_ReturnsRunsInOrder", async () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(run("r1", T0));
    src.recordRun(run("r2", T0));
    src.recordRun(run("r3", T0));

    const journal = await src.getJournal();
    expect(journal.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("Construction_RestoresFromStorage", async () => {
    const storage = makeStorage();
    storage.setItem(KEY, JSON.stringify({ schema: 1, savedAt: NOW, journal: { runs: [run("r1", T0)] } }));

    const src = new PersistentTraceSource({ storage, now: () => NOW });

    const journal = await src.getJournal();
    expect(journal.runs.map((r) => r.id)).toEqual(["r1"]);
  });

  it("Construction_DropsSchemaMismatch", async () => {
    const storage = makeStorage();
    storage.setItem(KEY, JSON.stringify({ schema: 99, savedAt: NOW, journal: { runs: [run("r1", T0)] } }));

    const src = new PersistentTraceSource({ storage, now: () => NOW });

    const journal = await src.getJournal();
    expect(journal.runs).toHaveLength(0);
  });

  it("Construction_DropsExpiredEntries", async () => {
    const storage = makeStorage();
    const stale = run("stale", "2026-05-01T00:00:00.000Z");
    const fresh = run("fresh", T0);
    storage.setItem(KEY, JSON.stringify({ schema: 1, savedAt: NOW, journal: { runs: [stale, fresh] } }));

    const src = new PersistentTraceSource({ storage, now: () => NOW, ttlMinutes: 60 });

    const journal = await src.getJournal();
    expect(journal.runs.map((r) => r.id)).toEqual(["fresh"]);
    // expired entries are dropped and the storage is rewritten without them
    expect(readEnvelope(storage).journal.runs.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("Tokens_AreRedacted_WhenPersistTokensFalse", () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(
      run("r1", T0, [
        step(1, [
          variable("access_token", "token" as VariableKind, "super-secret-opaque"),
          variable("id_token", "Jwt", "eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2"),
          variable("state", "Plain", "abc123"),
        ]),
      ]),
    );

    const vars = readEnvelope(storage).journal.runs[0].steps[0].vars;
    expect(vars.find((v) => v.name === "access_token")).toEqual({
      name: "access_token",
      value: "[redacted]",
      kind: "token",
    });
    expect(vars.find((v) => v.name === "id_token")).toEqual({
      name: "id_token",
      value: "[redacted]",
      kind: "Jwt",
    });
    expect(vars.find((v) => v.name === "state")).toEqual({ name: "state", kind: "Plain", value: "abc123" });
  });

  it("Tokens_AreKept_WhenPersistTokensTrue", () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW, persistTokens: true });

    src.recordRun(
      run("r1", T0, [
        step(1, [
          variable("access_token", "token" as VariableKind, "super-secret-opaque"),
          variable("id_token", "Jwt", "eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2"),
        ]),
      ]),
    );

    const vars = readEnvelope(storage).journal.runs[0].steps[0].vars;
    expect(vars.find((v) => v.name === "access_token")?.value).toBe("super-secret-opaque");
    expect(vars.find((v) => v.name === "id_token")?.value).toBe("eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2");
  });

  it("RingBuffer_EvictsOldestUntilUnderCap", async () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW, maxSizeKb: 1 });
    const blob = "x".repeat(600);

    src.recordRun(run("r1", "2026-05-30T10:00:00.000Z", [step(1, [variable("d", "Plain", blob)])]));
    src.recordRun(run("r2", "2026-05-30T10:01:00.000Z", [step(1, [variable("d", "Plain", blob)])]));
    src.recordRun(run("r3", "2026-05-30T10:02:00.000Z", [step(1, [variable("d", "Plain", blob)])]));

    const persisted = storage.dump()[KEY];
    expect(persisted.length).toBeLessThanOrEqual(1024);

    const env = readEnvelope(storage);
    const ids = env.journal.runs.map((r) => r.id);
    expect(ids).not.toContain("r1"); // oldest evicted
    expect(ids).toContain("r3"); // newest kept
    expect(ids.length).toBeLessThan(3);

    // the in-memory mirror is bounded too, not just the storage copy
    const journal = await src.getJournal();
    expect(journal.runs.map((r) => r.id)).not.toContain("r1");
  });

  it("Clear_WipesMemoryAndStorage", async () => {
    const storage = makeStorage();
    const src = new PersistentTraceSource({ storage, now: () => NOW });

    src.recordRun(run("r1", T0));
    src.clear();

    const journal = await src.getJournal();
    expect(journal.runs).toHaveLength(0);
    expect(storage.dump()[KEY]).toBeUndefined();
  });

  it("StorageThrows_FallsBackSilentlyToMemoryOnly", async () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const src = new PersistentTraceSource({ storage: failing, now: () => NOW });

    expect(() => src.recordRun(run("r1", T0))).not.toThrow();
    expect(() => src.recordStep("r1", step(1))).not.toThrow();

    const journal = await src.getJournal();
    expect(journal.runs).toHaveLength(1);
    expect(journal.runs[0].steps).toHaveLength(1);
  });

  it("GetJournal_FiltersExpiredAtReadTime", async () => {
    const storage = makeStorage();
    let current = Date.parse(T0);
    const src = new PersistentTraceSource({ storage, now: () => current, ttlMinutes: 60 });

    src.recordRun(run("r1", T0));
    expect((await src.getJournal()).runs).toHaveLength(1);

    current = Date.parse("2026-05-30T11:30:00.000Z"); // 90 minutes later, ttl is 60
    expect((await src.getJournal()).runs).toHaveLength(0);
  });

  it("Construction_RejectsNegativeTtl", () => {
    expect(() => new PersistentTraceSource({ ttlMinutes: -1 })).toThrow(/ttlMinutes/);
  });
});
