import { describe, it, expect } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { TokenInspectPanel } from "../TokenInspectPanel";
import type { TraceJournal, TraceSource } from "@token-inspect/core";

const SAMPLE_JOURNAL: TraceJournal = {
  sessionId: "sess-src",
  runs: [
    {
      id: "run-src-1",
      flowKind: "auth.login",
      title: "Source Login Flow",
      status: "Completed",
      startedAt: "2026-05-30T10:00:00Z",
      participants: ["Browser", "BFF"],
      steps: [
        {
          ordinal: 0,
          label: "Redirect to login",
          from: "Browser",
          to: "BFF",
          timestamp: "2026-05-30T10:00:00Z",
          vars: [],
        },
      ],
    },
  ],
};

/** Synchronous in-memory TraceSource that emits the journal on subscribe. */
function fakeSource(journal: TraceJournal): TraceSource {
  return {
    getJournal: () => journal,
    subscribe: (cb) => {
      cb(journal);
      return () => {};
    },
  };
}

describe("TokenInspectPanel with source prop", () => {
  it("renders the flow run from the source prop after opening", async () => {
    render(<TokenInspectPanel source={fakeSource(SAMPLE_JOURNAL)} app="customer" />);

    fireEvent.click(screen.getByRole("button", { name: /token inspect/i }));

    await waitFor(() => expect(screen.getByText(/auth\.login/i)).toBeInTheDocument());
    expect(screen.getByText(/source login flow/i)).toBeInTheDocument();
  });
});
