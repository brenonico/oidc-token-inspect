namespace TokenInspect;
public sealed class FlowRecorder(ITraceStore store) : IFlowRecorder
{
    public FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null)
    {
        var run = new FlowRun { FlowKind = flowKind, Title = title, Participants = participants, CorrelationKey = correlationKey, Source = source };
        if (correlationKey is not null)
        {
            try { store.SaveRunAsync(correlationKey, run).GetAwaiter().GetResult(); }
            catch { /* instrumentation must never break the host flow */ }
        }
        return run;
    }
    public FlowRun? ResumeRun(string correlationKey)
    {
        try { return store.GetRunAsync(correlationKey).GetAwaiter().GetResult(); }
        catch { return null; /* instrumentation must never break the host flow */ }
    }
    public void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null)
    {
        // Logical per-source ordinal: count of existing steps from THIS run's source, plus 1.
        // For a single-source host run this equals the step ordinal (Steps.Count + 1).
        var seq = run.Steps.Count(s => s.Source == run.Source) + 1;
        run.Steps.Add(new TraceStep(run.Steps.Count + 1, label, from, to, DateTimeOffset.UtcNow, vars,
            note, shortLabel, seq, run.Source));
        // Persist under the correlationKey while the run is mid-flight so ResumeRun (after a
        // redirect) recovers the run WITH the steps recorded so far; falls back to run.Id otherwise.
        try { store.SaveRunAsync(run.CorrelationKey ?? run.Id, run).GetAwaiter().GetResult(); }
        catch { /* instrumentation must never break the host flow */ }
    }
    public void Complete(FlowRun run, string sessionId)
    {
        run.Status = FlowStatus.Completed;
        run.EndedAt = DateTimeOffset.UtcNow;
        try { store.AppendToJournalAsync(sessionId, run).GetAwaiter().GetResult(); }
        catch { /* instrumentation must never break the host flow */ }
    }
    public void Fail(FlowRun run, string error)
    {
        run.Status = FlowStatus.Failed;
        run.Error = error;
        run.EndedAt = DateTimeOffset.UtcNow;
        try { store.SaveRunAsync(run.CorrelationKey ?? run.Id, run).GetAwaiter().GetResult(); }
        catch { /* instrumentation must never break the host flow */ }
    }
    public async Task<FlowRun?> AdoptAnonymousRun(string anonymousRunId, string sessionId, IDictionary<string, string>? metadata = null, CancellationToken ct = default)
    {
        FlowRun? run;
        try { run = await store.GetRunAsync(anonymousRunId, ct).ConfigureAwait(false); }
        catch { return null; /* instrumentation must never break the host flow */ }
        if (run is null) return null;

        // Re-key the in-flight run under the authenticated session id, then re-point the run's
        // own resume key so any step recorded after adoption persists under the session id too.
        try { await store.RekeyRunAsync(anonymousRunId, sessionId, ct).ConfigureAwait(false); }
        catch { /* best-effort: a failed re-key still returns the run to the caller */ }
        run.CorrelationKey = sessionId;
        if (metadata is { Count: > 0 })
        {
            run.Metadata ??= new Dictionary<string, string>();
            foreach (var kv in metadata) run.Metadata[kv.Key] = kv.Value;
        }
        try { await store.SaveRunAsync(sessionId, run, ct).ConfigureAwait(false); }
        catch { /* instrumentation must never break the host flow */ }
        return run;
    }
}
