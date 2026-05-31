namespace TokenInspect;
public interface IFlowRecorder
{
    FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null);
    FlowRun? ResumeRun(string correlationKey);
    void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null);
    void Complete(FlowRun run, string sessionId);
    void Fail(FlowRun run, string error);
}
