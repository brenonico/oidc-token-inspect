using System.Collections.Generic;
using System.Threading.Tasks;
using TokenInspect;
using Xunit;

// Records every call so tests can assert routing and isolation without depending on FlowRecorder
// or a store. Mirrors the real recorder's in-memory mutations (appends steps, sets status) so
// assertions can read straight off the FlowRun.
file sealed class RecordingFlowRecorder : IFlowRecorder
{
    public readonly List<(FlowRun run, string sessionId)> Completed = new();
    public readonly List<(FlowRun run, string error)> Failed = new();
    private readonly object _gate = new();

    public FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null)
        => new() { FlowKind = flowKind, Title = title, Participants = participants, CorrelationKey = correlationKey, Source = source };

    public FlowRun? ResumeRun(string correlationKey) => null;

    public void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null)
    {
        lock (_gate)
            run.Steps.Add(new TraceStep(run.Steps.Count + 1, label, from, to, default, vars, note, shortLabel));
    }

    public void Complete(FlowRun run, string sessionId)
    {
        run.Status = FlowStatus.Completed;
        lock (_gate) Completed.Add((run, sessionId));
    }

    public void Fail(FlowRun run, string error)
    {
        run.Status = FlowStatus.Failed;
        run.Error = error;
        lock (_gate) Failed.Add((run, error));
    }
}

public class InspectFlowTests : IDisposable
{
    public InspectFlowTests() => InspectFlowConfig.Recorder = null;
    public void Dispose() => InspectFlowConfig.Recorder = null;

    [Fact]
    public void Begin_Outside_DI_Throws()
    {
        InspectFlowConfig.Recorder = null;
        var ex = Assert.Throws<InvalidOperationException>(
            () => InspectFlow.Begin("auth.login", "Login"));
        Assert.Equal("InspectFlow.Begin requires AddTokenInspect() at startup", ex.Message);
    }

    [Fact]
    public void Step_Outside_Scope_Is_Noop()
    {
        InspectFlowConfig.Recorder = new RecordingFlowRecorder();
        Assert.Null(InspectFlow.Current);
        var ex = Record.Exception(() => InspectFlow.Step("noop", "A", "B"));
        Assert.Null(ex);
        Assert.Null(InspectFlow.Current);
    }

    [Fact]
    public void Begin_Creates_Scope_And_Step_Routes_To_It()
    {
        InspectFlowConfig.Recorder = new RecordingFlowRecorder();
        using var flow = InspectFlow.Begin("auth.stepup", "Step-up MFA", correlationId: "sess-1",
            actors: new[] { "Browser", "BFF", "Keycloak" });

        Assert.Same(flow, InspectFlow.Current);
        Assert.Equal("auth.stepup", flow.Run.FlowKind);
        Assert.Equal(new[] { "Browser", "BFF", "Keycloak" }, flow.Run.Participants);

        InspectFlow.Step("Request elevation", "Browser", "SessionManager",
            new[] { TraceVariable.Plain("acr_values", "stepup") });

        Assert.Single(flow.Run.Steps);
        Assert.Equal("Request elevation", flow.Run.Steps[0].Label);
        Assert.Equal("Browser", flow.Run.Steps[0].From);
    }

    [Fact]
    public void Nested_Scopes_Track_Innermost()
    {
        InspectFlowConfig.Recorder = new RecordingFlowRecorder();
        using var outer = InspectFlow.Begin("outer", "Outer");
        Assert.Same(outer, InspectFlow.Current);

        using (var inner = InspectFlow.Begin("inner", "Inner"))
        {
            Assert.Same(inner, InspectFlow.Current);
            InspectFlow.Step("inner step", "A", "B");
            Assert.Single(inner.Run.Steps);
            Assert.Empty(outer.Run.Steps);
        }

        Assert.Same(outer, InspectFlow.Current);
        InspectFlow.Step("outer step", "C", "D");
        Assert.Single(outer.Run.Steps);
        Assert.Equal("outer step", outer.Run.Steps[0].Label);
    }

    [Fact]
    public void Dispose_Without_Complete_Auto_Completes()
    {
        var recorder = new RecordingFlowRecorder();
        InspectFlowConfig.Recorder = recorder;

        FlowRun run;
        using (var flow = InspectFlow.Begin("auth.login", "Login", correlationId: "sess-2"))
            run = flow.Run;

        Assert.Single(recorder.Completed);
        Assert.Same(run, recorder.Completed[0].run);
        Assert.Equal("sess-2", recorder.Completed[0].sessionId);
        Assert.Equal(FlowStatus.Completed, run.Status);
        Assert.Null(InspectFlow.Current);
    }

    [Fact]
    public void Fail_Marks_Run_As_Failed()
    {
        var recorder = new RecordingFlowRecorder();
        InspectFlowConfig.Recorder = recorder;

        using (var flow = InspectFlow.Begin("auth.login", "Login"))
        {
            flow.Fail("boom");
            Assert.Equal(FlowStatus.Failed, flow.Run.Status);
            Assert.Equal("boom", flow.Run.Error);
        }

        Assert.Single(recorder.Failed);
        Assert.Equal("boom", recorder.Failed[0].error);
        // Dispose after a terminal Fail must not also complete the run.
        Assert.Empty(recorder.Completed);
    }

    [Fact]
    public async Task Concurrent_Flows_Do_Not_Bleed()
    {
        InspectFlowConfig.Recorder = new RecordingFlowRecorder();

        async Task<FlowRun> RunFlow(string kind, string label)
        {
            using var flow = InspectFlow.Begin(kind, label, actors: new[] { label });
            for (var i = 0; i < 5; i++)
            {
                InspectFlow.Step($"{label} step {i}", label, "X");
                await Task.Yield();
            }
            return flow.Run;
        }

        var a = Task.Run(() => RunFlow("flow.a", "A"));
        var b = Task.Run(() => RunFlow("flow.b", "B"));
        var runs = await Task.WhenAll(a, b);

        foreach (var run in runs)
        {
            Assert.Equal(5, run.Steps.Count);
            // Every step recorded in this run must originate from this run's own flow, never the other's.
            Assert.All(run.Steps, s => Assert.Equal(run.Participants[0], s.From));
        }
        Assert.NotSame(runs[0], runs[1]);
        Assert.Null(InspectFlow.Current);
    }

    [Fact]
    public void Exception_In_Using_Body_Still_Disposes()
    {
        var recorder = new RecordingFlowRecorder();
        InspectFlowConfig.Recorder = recorder;

        InvalidOperationException? caught = null;
        try
        {
            using var flow = InspectFlow.Begin("auth.login", "Login", correlationId: "sess-3");
            InspectFlow.Step("before throw", "A", "B");
            throw new InvalidOperationException("body failed");
        }
        catch (InvalidOperationException ex)
        {
            caught = ex;
        }

        Assert.NotNull(caught);
        Assert.Single(recorder.Completed);
        Assert.Equal("sess-3", recorder.Completed[0].sessionId);
        Assert.Null(InspectFlow.Current);
    }
}
