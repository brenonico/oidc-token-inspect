import { describe, it, expect } from "vitest";
import type { FlowRun } from "../schema";

describe("schema round-trip", () => {
  it("preserves correlationId, source, and per-step seq/source through JSON", () => {
    const run: FlowRun = {
      id: "run-1",
      flowKind: "authorization_code",
      title: "Login (PKCE)",
      status: "Completed",
      startedAt: "2026-05-30T10:00:00.000Z",
      endedAt: "2026-05-30T10:00:01.000Z",
      error: null,
      participants: ["browser", "kc", "bff"],
      correlationId: "corr-abc",
      source: "merged",
      fanOut: false,
      steps: [
        {
          ordinal: 1,
          label: "Redirect to authorize",
          short: "authorize",
          from: "browser",
          to: "kc",
          timestamp: "2026-05-30T10:00:00.100Z",
          vars: [{ name: "code_challenge", kind: "Hash", value: "abc", redacted: false }],
          note: "PKCE",
          source: "client",
          seq: 1,
        },
        {
          ordinal: 2,
          label: "Token exchange",
          short: "token",
          from: "bff",
          to: "kc",
          timestamp: "2026-05-30T10:00:00.900Z",
          vars: [{ name: "access_token", kind: "Jwt", value: "x.y.z", redacted: true }],
          note: null,
          source: "server",
          seq: 2,
        },
      ],
    };

    const round = JSON.parse(JSON.stringify(run)) as FlowRun;

    expect(round).toEqual(run);
    expect(round.correlationId).toBe("corr-abc");
    expect(round.source).toBe("merged");
    expect(round.fanOut).toBe(false);
    expect(round.steps[0].source).toBe("client");
    expect(round.steps[0].seq).toBe(1);
    expect(round.steps[1].source).toBe("server");
    expect(round.steps[1].seq).toBe(2);
    expect(round.steps[0].vars[0].redacted).toBe(false);
    expect(round.steps[1].vars[0].redacted).toBe(true);
  });
});
