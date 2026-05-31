import { describe, it, expect } from "vitest";
import { mergeByCorrelation } from "../CompositeTraceSource";
import type { FlowRun, TraceOrigin, TraceStep } from "../schema";

function step(seq: number, label: string, source: Exclude<TraceOrigin, "merged">): TraceStep {
  return {
    ordinal: seq,
    label,
    from: "a",
    to: "b",
    timestamp: "2026-05-30T10:00:00.000Z",
    vars: [],
    source,
    seq,
  };
}

function run(
  id: string,
  correlationId: string | undefined,
  source: TraceOrigin,
  steps: TraceStep[],
): FlowRun {
  return {
    id,
    flowKind: "authorization_code",
    title: `run ${id}`,
    status: "Completed",
    startedAt: "2026-05-30T10:00:00.000Z",
    participants: ["a", "b"],
    correlationId,
    source,
    steps,
  };
}

describe("mergeByCorrelation", () => {
  it("merges two sources sharing a correlationId into one ordered merged run", () => {
    const client = run("client-run", "c1", "client", [
      step(1, "A", "client"),
      step(2, "B", "client"),
    ]);
    const server = run("server-run", "c1", "server", [
      step(1, "X", "server"),
      step(2, "Y", "server"),
    ]);

    const result = mergeByCorrelation([client, server]);

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.source).toBe("merged");
    expect(merged.steps.map((s) => s.label)).toEqual(["A", "B", "X", "Y"]);
    expect(merged.steps.map((s) => s.source)).toEqual(["client", "client", "server", "server"]);
    expect(merged.fanOut).toBeUndefined();
  });

  it("does NOT merge runs with distinct correlationIds", () => {
    const a = run("a", "c1", "client", [step(1, "A", "client")]);
    const b = run("b", "c2", "server", [step(1, "B", "server")]);

    const result = mergeByCorrelation([a, b]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(result.every((r) => r.source !== "merged")).toBe(true);
  });

  it("does NOT merge runs without a correlationId", () => {
    const a = run("a", undefined, "client", [step(1, "A", "client")]);
    const b = run("b", undefined, "server", [step(1, "B", "server")]);

    const result = mergeByCorrelation([a, b]);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.source !== "merged")).toBe(true);
  });

  it("sets fanOut when more than two distinct sources share a correlationId", () => {
    const client = run("client-run", "c1", "client", [step(1, "A", "client")]);
    const server = run("server-run", "c1", "server", [step(1, "X", "server")]);
    const bff = run("bff-run", "c1", "bff", [step(1, "Z", "bff")]);

    const result = mergeByCorrelation([client, server, bff]);

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.source).toBe("merged");
    expect(merged.fanOut).toBe(true);
    // ordered client < server < bff, nothing hidden
    expect(merged.steps.map((s) => s.label)).toEqual(["A", "X", "Z"]);
  });
});
