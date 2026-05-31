namespace TokenInspect;
public interface IFlowRecorder
{
    FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null);
    FlowRun? ResumeRun(string correlationKey);
    void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null);
    void Complete(FlowRun run, string sessionId);
    void Fail(FlowRun run, string error);

    /// <summary>Adopts an anonymous (pre-login) run, re-keying it under an authenticated
    /// <paramref name="sessionId"/> so the pre-login and post-login steps form one continuous run.
    /// Looks up the run by <paramref name="anonymousRunId"/>; if found, re-keys it via the
    /// underlying <see cref="ITraceStore"/>, optionally merges <paramref name="metadata"/> into the
    /// run, and returns the resumed run. Returns <c>null</c> when no run exists for the id, leaving
    /// the caller to decide whether to begin a fresh run. The default implementation is a no-op that
    /// returns <c>null</c> (for recorders without a backing store).</summary>
    Task<FlowRun?> AdoptAnonymousRun(string anonymousRunId, string sessionId, IDictionary<string, string>? metadata = null, CancellationToken ct = default)
        => Task.FromResult<FlowRun?>(null);
}
