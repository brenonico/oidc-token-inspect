namespace TokenInspect;
/// <summary>
/// Ambient activity-scope API over <see cref="IFlowRecorder"/>. Open a scope at a flow's entry
/// point with <see cref="Begin"/>, then record steps from any nested layer via <see cref="Step"/>
/// without threading an <see cref="IFlowRecorder"/> through the call stack. The active scope flows
/// with the logical async context via an <see cref="AsyncLocal{T}"/>, so concurrent flows stay isolated.
/// </summary>
public static class InspectFlow
{
    private static readonly AsyncLocal<InspectScope?> _current = new();

    /// <summary>The innermost active scope on the current logical async context, or null if none is open.</summary>
    public static InspectScope? Current => _current.Value;

    /// <summary>
    /// Opens a new ambient flow scope and makes it <see cref="Current"/>. A scope opened while another
    /// is active nests under it; disposing restores the parent.
    /// </summary>
    /// <exception cref="InvalidOperationException">No recorder is wired (i.e. <c>AddTokenInspect()</c> did not run).</exception>
    public static InspectScope Begin(string flowType, string summary, string? correlationId = null, IReadOnlyList<string>? actors = null)
    {
        var recorder = InspectFlowConfig.Recorder
            ?? throw new InvalidOperationException("InspectFlow.Begin requires AddTokenInspect() at startup");
        var run = recorder.BeginRun(flowType, summary, actors ?? Array.Empty<string>(), correlationId);
        var scope = new InspectScope(recorder, run, _current.Value);
        _current.Value = scope;
        return scope;
    }

    /// <summary>
    /// Records a step into the <see cref="Current"/> scope. A silent no-op when no scope is open, so
    /// instrumented code can call it unconditionally regardless of whether a flow is being traced.
    /// </summary>
    public static void Step(string summary, string from, string to, IReadOnlyList<TraceVariable>? variables = null)
        => _current.Value?.Record(summary, from, to, variables ?? Array.Empty<TraceVariable>());

    internal static void Restore(InspectScope? parent) => _current.Value = parent;
}
