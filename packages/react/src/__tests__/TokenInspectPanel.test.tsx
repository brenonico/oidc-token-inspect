import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { TokenInspectPanel } from "../TokenInspectPanel";
import type { TraceJournal } from "../trace-schema";

// eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.
const SAMPLE_JWT =
  "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEyMyIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.sig";

const SAMPLE_JOURNAL: TraceJournal = {
  sessionId: "sess-abc",
  runs: [
    {
      id: "run-1",
      flowKind: "auth.login",
      title: "Login Flow",
      status: "Completed",
      startedAt: "2026-05-29T10:00:00Z",
      endedAt: "2026-05-29T10:00:05Z",
      participants: ["Browser", "BFF", "AuthServer"],
      steps: [
        {
          ordinal: 0,
          label: "Redirect to login",
          from: "Browser",
          to: "BFF",
          timestamp: "2026-05-29T10:00:00Z",
          vars: [],
        },
        {
          ordinal: 1,
          label: "PKCE challenge",
          from: "BFF",
          to: "AuthServer",
          timestamp: "2026-05-29T10:00:01Z",
          vars: [{ name: "code_verifier", kind: "Code", value: "abc123def456" }],
        },
        {
          ordinal: 2,
          label: "Auth code received",
          from: "AuthServer",
          to: "BFF",
          timestamp: "2026-05-29T10:00:02Z",
          vars: [{ name: "auth_code", kind: "Opaque", value: "secret-code-xyz" }],
        },
        {
          ordinal: 3,
          label: "Token exchange",
          from: "BFF",
          to: "AuthServer",
          timestamp: "2026-05-29T10:00:03Z",
          vars: [{ name: "access_token", kind: "Jwt", value: SAMPLE_JWT }],
        },
        {
          ordinal: 4,
          label: "Session established",
          from: "AuthServer",
          to: "BFF",
          timestamp: "2026-05-29T10:00:04Z",
          vars: [{ name: "session_id", kind: "Plain", value: "sess-abc" }],
        },
        {
          ordinal: 5,
          label: "Redirect to app",
          from: "BFF",
          to: "Browser",
          timestamp: "2026-05-29T10:00:05Z",
          vars: [{ name: "redirect_url", kind: "Url", value: "https://app.example.com/" }],
        },
      ],
    },
  ],
};

describe("TokenInspectPanel", () => {
  let get: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    get = vi.fn().mockResolvedValue(SAMPLE_JOURNAL);
  });

  it("renders the toggle button", () => {
    render(<TokenInspectPanel client={{ get }} endpoint="/api/customer/inspect" />);
    expect(screen.getByRole("button", { name: /token inspect/i })).toBeInTheDocument();
  });

  it("opens the panel when the toggle button is clicked", async () => {
    render(<TokenInspectPanel client={{ get }} endpoint="/api/customer/inspect" />);

    fireEvent.click(screen.getByRole("button", { name: /token inspect/i }));

    // Panel heading should appear
    await waitFor(() => expect(screen.getByRole("heading", { name: /token inspect/i })).toBeInTheDocument());
  });

  it("shows the flow run title after opening", async () => {
    render(<TokenInspectPanel client={{ get }} endpoint="/api/customer/inspect" />);

    fireEvent.click(screen.getByRole("button", { name: /token inspect/i }));

    await waitFor(() => expect(screen.getByText(/auth\.login/i)).toBeInTheDocument());
  });

  it("clicking Decode on a Jwt var reveals the payload sub field", async () => {
    render(<TokenInspectPanel client={{ get }} endpoint="/api/customer/inspect" />);

    // Open the panel
    fireEvent.click(screen.getByRole("button", { name: /token inspect/i }));

    // Wait for run to appear
    await waitFor(() => screen.getByText(/auth\.login/i));

    // Navigate to step 3 (Token exchange) which has the JWT
    const stepButtons = await screen.findAllByRole("button", { name: /token exchange/i });
    fireEvent.click(stepButtons[0]);

    // The variable "access_token" (Jwt kind) should appear
    await waitFor(() => screen.getByText(/access_token/i));

    // Click Decode button
    fireEvent.click(screen.getByRole("button", { name: /^decode$/i }));

    // Should reveal decoded payload including sub field
    await waitFor(() => expect(screen.getByText(/user-123/i)).toBeInTheDocument());
  });

  it("clicking Reveal on an Opaque var shows raw value", async () => {
    render(<TokenInspectPanel client={{ get }} endpoint="/api/customer/inspect" />);

    fireEvent.click(screen.getByRole("button", { name: /token inspect/i }));
    await waitFor(() => screen.getByText(/auth\.login/i));

    // Navigate to step 2 (Auth code received) which has Opaque var
    const stepButtons = await screen.findAllByRole("button", { name: /auth code received/i });
    fireEvent.click(stepButtons[0]);

    await waitFor(() => screen.getByText(/auth_code/i));

    fireEvent.click(screen.getByRole("button", { name: /^reveal$/i }));

    await waitFor(() => expect(screen.getByText(/secret-code-xyz/i)).toBeInTheDocument());
  });
});
