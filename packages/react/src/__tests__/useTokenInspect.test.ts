import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTokenInspect } from "../useTokenInspect";
import type { FlowRun, TraceJournal, TraceSource } from "@oidc-token-inspect/core";

function run(id: string): FlowRun {
  return {
    id,
    flowKind: "auth.login",
    title: "Login",
    status: "Completed",
    startedAt: "",
    participants: ["Browser"],
    steps: [],
  };
}

/**
 * Minimal fake TraceSource with a controllable emitter. `subscribe` immediately
 * delivers the current journal and records the latest callback so a test can
 * push a second emit. The returned unsub is a spy.
 */
function makeFakeSource(initial: TraceJournal) {
  let journal = initial;
  let cb: ((j: TraceJournal) => void) | null = null;
  const unsub = vi.fn();
  const subscribe = vi.fn((fn: (j: TraceJournal) => void) => {
    cb = fn;
    fn(journal);
    return unsub;
  });
  const source: TraceSource = {
    getJournal: () => journal,
    subscribe,
  };
  return {
    source,
    subscribe,
    unsub,
    emit(next: TraceJournal) {
      journal = next;
      cb?.(next);
    },
  };
}

describe("useTokenInspect", () => {
  it("subscribes and populates runs when open", async () => {
    const fake = makeFakeSource({ sessionId: "s1", runs: [run("r1")] });

    const { result } = renderHook(() =>
      useTokenInspect({ source: fake.source, open: true }),
    );

    await waitFor(() => expect(result.current.runs.length).toBe(1));
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not subscribe when open is false", async () => {
    const fake = makeFakeSource({ sessionId: "s1", runs: [run("r1")] });

    const { result } = renderHook(() =>
      useTokenInspect({ source: fake.source, open: false }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(fake.subscribe).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);
  });

  it("updates runs on a second emit", async () => {
    const fake = makeFakeSource({ sessionId: "s1", runs: [run("r1")] });

    const { result } = renderHook(() =>
      useTokenInspect({ source: fake.source, open: true }),
    );

    await waitFor(() => expect(result.current.runs.length).toBe(1));

    await act(async () => {
      fake.emit({ sessionId: "s1", runs: [run("r1"), run("r2")] });
    });

    await waitFor(() => expect(result.current.runs.length).toBe(2));
    expect(result.current.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("calls unsub when the panel closes", async () => {
    const fake = makeFakeSource({ sessionId: "s1", runs: [run("r1")] });

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useTokenInspect({ source: fake.source, open }),
      { initialProps: { open: true } },
    );

    await waitFor(() => expect(result.current.runs.length).toBe(1));
    expect(fake.unsub).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ open: false });
    });

    expect(fake.unsub).toHaveBeenCalledTimes(1);
  });

  it("calls unsub on unmount", async () => {
    const fake = makeFakeSource({ sessionId: "s1", runs: [run("r1")] });

    const { result, unmount } = renderHook(() =>
      useTokenInspect({ source: fake.source, open: true }),
    );

    await waitFor(() => expect(result.current.runs.length).toBe(1));
    expect(fake.unsub).not.toHaveBeenCalled();

    unmount();
    expect(fake.unsub).toHaveBeenCalledTimes(1);
  });
});
