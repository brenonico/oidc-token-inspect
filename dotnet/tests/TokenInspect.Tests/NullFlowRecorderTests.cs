using TokenInspect;
using Xunit;
public class NullFlowRecorderTests
{
    [Fact]
    public void Null_recorder_never_throws_and_records_nothing()
    {
        IFlowRecorder rec = new NullFlowRecorder();
        var run = rec.BeginRun("auth.login", "Login", new[] { "A", "B" }, correlationKey: "s1", source: "bff");
        rec.Step(run, "x", "A", "B", Array.Empty<TraceVariable>(), shortLabel: "X");
        rec.Complete(run, "session-1");
        Assert.Null(rec.ResumeRun("s1"));
        // Null recorder records nothing even with the new parity params.
        Assert.Empty(run.Steps);
    }
}
