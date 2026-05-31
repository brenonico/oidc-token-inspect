import { describe, it, expect, vi } from "vitest";
import { LiveTraceSource } from "../LiveTraceSource";
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

describe("LiveTraceSource", () => {
  it("delivers an upserted run to a subscriber", () => {
    const src = new LiveTraceSource("sess-1");
    const received: TraceJournal[] = [];
    src.subscribe((j) => received.push(j));

    const r1 = run("r1", "first");
    src.upsertRun(r1);

    const last = received[received.length - 1];
    expect(last.runs).toHaveLength(1);
    expect(last.runs[0].id).toBe("r1");
    expect(last.runs[0].title).toBe("first");
  });

  it("updates an existing run by id without duplicating", () => {
    const src = new LiveTraceSource();
    const cb = vi.fn();
    src.subscribe(cb);

    src.upsertRun(run("r1", "first"));
    src.upsertRun(run("r1", "updated"));

    const last = cb.mock.calls[cb.mock.calls.length - 1][0] as TraceJournal;
    expect(last.runs).toHaveLength(1);
    expect(last.runs[0].title).toBe("updated");
  });

  it("stops calling back after unsubscribe", () => {
    const src = new LiveTraceSource();
    const cb = vi.fn();
    const unsub = src.subscribe(cb);

    src.upsertRun(run("r1", "first"));
    const callsBefore = cb.mock.calls.length;

    unsub();
    src.upsertRun(run("r2", "second"));

    expect(cb.mock.calls.length).toBe(callsBefore);
  });

  it("emits the current journal immediately on subscribe", () => {
    const src = new LiveTraceSource();
    src.upsertRun(run("r1", "first"));

    const cb = vi.fn();
    src.subscribe(cb);

    expect(cb).toHaveBeenCalledTimes(1);
    const j = cb.mock.calls[0][0] as TraceJournal;
    expect(j.runs).toHaveLength(1);
  });
});
