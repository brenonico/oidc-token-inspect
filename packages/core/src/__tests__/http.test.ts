import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpTraceSource, type HttpClient } from "../HttpTraceSource";
import type { FlowRun, TraceJournal } from "../schema";

function run(id: string, title: string): FlowRun {
  return {
    id,
    flowKind: "authorization_code",
    title,
    status: "Running",
    startedAt: "2026-05-30T10:00:00.000Z",
    participants: ["browser"],
    steps: [],
  };
}

function journal(...runs: FlowRun[]): TraceJournal {
  return { runs };
}

/** Controllable fake HttpClient: counts calls and resolves with a queue/last value. */
function fakeClient(initial: TraceJournal) {
  let next: () => Promise<TraceJournal> = () => Promise.resolve(initial);
  const client: HttpClient = {
    get: vi.fn(<T>(_path: string): Promise<T> => next() as unknown as Promise<T>),
  };
  return {
    client,
    get: client.get as ReturnType<typeof vi.fn>,
    /** Make subsequent calls resolve with this journal. */
    resolveWith(j: TraceJournal) {
      next = () => Promise.resolve(j);
    },
    /** Make subsequent calls reject. */
    rejectWith(err: unknown) {
      next = () => Promise.reject(err);
    },
  };
}

const ENDPOINT = "/trace/journal";

describe("HttpTraceSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("getJournal() calls client.get(endpoint) and returns/caches the journal", async () => {
    const j = journal(run("r1", "first"));
    const fake = fakeClient(j);
    const src = new HttpTraceSource(fake.client, ENDPOINT, 4000);

    const result = await src.getJournal();

    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.get).toHaveBeenCalledWith(ENDPOINT);
    expect(result).toEqual(j);
    expect(result.runs[0].id).toBe("r1");

    // A second call hits the client again and updates the cache.
    const j2 = journal(run("r2", "second"));
    fake.resolveWith(j2);
    const result2 = await src.getJournal();
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(result2).toEqual(j2);
  });

  it("subscribe() triggers an immediate first fetch and calls cb with the journal", async () => {
    const j = journal(run("r1", "first"));
    const fake = fakeClient(j);
    const src = new HttpTraceSource(fake.client, ENDPOINT, 4000);

    const cb = vi.fn();
    src.subscribe(cb);

    // The tick is fired synchronously but resolves on a microtask.
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();

    // Flush the pending tick microtasks.
    await vi.advanceTimersByTimeAsync(0);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(j);
  });

  it("polls again after refreshMs (interval tick re-fetches)", async () => {
    const refreshMs = 4000;
    const fake = fakeClient(journal(run("r1", "first")));
    const src = new HttpTraceSource(fake.client, ENDPOINT, refreshMs);

    const cb = vi.fn();
    src.subscribe(cb);

    // Initial immediate fetch.
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);

    // Advance one interval -> one more poll.
    fake.resolveWith(journal(run("r1", "first"), run("r2", "second")));
    await vi.advanceTimersByTimeAsync(refreshMs);
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].runs).toHaveLength(2);

    // Advance another interval -> another poll.
    await vi.advanceTimersByTimeAsync(refreshMs);
    expect(fake.get).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("swallows a rejecting client.get without throwing out of the poll", async () => {
    const refreshMs = 4000;
    const good = journal(run("r1", "first"));
    const fake = fakeClient(good);
    const src = new HttpTraceSource(fake.client, ENDPOINT, refreshMs);

    const cb = vi.fn();
    src.subscribe(cb);

    // First (immediate) tick succeeds.
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // Next tick rejects: must NOT throw, must NOT call cb, no unhandled rejection.
    fake.rejectWith(new Error("backend hiccup"));
    // Advancing through the failing tick must not reject out of the poll.
    await expect(vi.advanceTimersByTimeAsync(refreshMs)).resolves.not.toThrow();
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledTimes(1); // still 1: no callback for the failing tick

    // Recovery: a later successful tick resumes delivering to cb.
    fake.resolveWith(good);
    await vi.advanceTimersByTimeAsync(refreshMs);
    expect(fake.get).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("stops polling and calling cb after unsubscribe (clearInterval)", async () => {
    const refreshMs = 4000;
    const fake = fakeClient(journal(run("r1", "first")));
    const src = new HttpTraceSource(fake.client, ENDPOINT, refreshMs);

    const cb = vi.fn();
    const unsub = src.subscribe(cb);

    await vi.advanceTimersByTimeAsync(0);
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();

    // Advance several intervals: no more fetches, no more callbacks.
    await vi.advanceTimersByTimeAsync(refreshMs * 3);
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);

    // No interval timers remain pending.
    expect(vi.getTimerCount()).toBe(0);
  });
});
