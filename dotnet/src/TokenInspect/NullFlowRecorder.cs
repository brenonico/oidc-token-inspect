namespace TokenInspect;
public sealed class NullFlowRecorder : IFlowRecorder
{
    public FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null)
        => new() { FlowKind = flowKind, Title = title, Participants = participants };
    public FlowRun? ResumeRun(string correlationKey) => null;
    public void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null) { }
    public void Complete(FlowRun run, string sessionId) { }
    public void Fail(FlowRun run, string error) { }
}
