namespace TokenInspect;
/// <summary>
/// An ambient flow activity opened by <see cref="InspectFlow.Begin"/>. Disposing the scope
/// auto-completes the run unless it was already terminated via <see cref="Complete"/> or
/// <see cref="Fail"/>, and restores the parent scope (if any) as <see cref="InspectFlow.Current"/>.
/// </summary>
public sealed class InspectScope : IDisposable
{
    private readonly IFlowRecorder _recorder;
    private bool _completed;
    private bool _disposed;

    internal InspectScope(IFlowRecorder recorder, FlowRun run, InspectScope? parent)
    {
        _recorder = recorder;
        Run = run;
        Parent = parent;
    }

    /// <summary>The run this scope records into.</summary>
    public FlowRun Run { get; }

    internal InspectScope? Parent { get; }

    internal void Record(string summary, string from, string to, IReadOnlyList<TraceVariable> variables)
        => _recorder.Step(Run, summary, from, to, variables);

    /// <summary>
    /// Marks the run completed and appends it to the journal under <paramref name="correlationId"/>
    /// (falling back to the run's correlation key, then its id). Idempotent once the scope is terminal.
    /// </summary>
    public void Complete(string? correlationId = null)
    {
        if (_completed) return;
        _completed = true;
        _recorder.Complete(Run, correlationId ?? Run.CorrelationKey ?? Run.Id);
    }

    /// <summary>Marks the run failed with <paramref name="reason"/>. Idempotent once the scope is terminal.</summary>
    public void Fail(string reason)
    {
        if (_completed) return;
        _completed = true;
        _recorder.Fail(Run, reason);
    }

    /// <summary>Auto-completes the run if it was not already terminated, then restores the parent scope.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (!_completed) Complete();
        InspectFlow.Restore(Parent);
    }
}
