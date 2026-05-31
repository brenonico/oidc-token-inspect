using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TokenInspect;
using Xunit;
// Clones runs on the way in and out (via JSON round-trip) to faithfully mimic a real
// serializing store like Redis — which returns deep copies, NOT shared object references.
// This is what makes the resume/stitch test meaningful: a fake that stored the live
// reference would pass even if the recorder never re-persisted the mid-flight steps.
file sealed class InMemoryTraceStore : ITraceStore
{
    public ConcurrentDictionary<string, FlowRun> Runs = new();
    public ConcurrentDictionary<string, List<FlowRun>> Journals = new();
    private static FlowRun Clone(FlowRun run) => JsonSerializer.Deserialize<FlowRun>(JsonSerializer.Serialize(run))!;
    public Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default) { Runs[key] = Clone(run); return Task.CompletedTask; }
    public Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default)
        => Task.FromResult(Runs.TryGetValue(key, out var r) ? Clone(r) : null);
    public Task AppendToJournalAsync(string sid, FlowRun run, CancellationToken ct = default)
        { Journals.GetOrAdd(sid, _ => new()).Add(Clone(run)); return Task.CompletedTask; }
    public Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sid, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<FlowRun>>(Journals.GetValueOrDefault(sid) ?? new List<FlowRun>());
}
file sealed class ThrowingTraceStore : ITraceStore
{
    public Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default)
        => throw new InvalidOperationException("store down");
    public Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default)
        => throw new InvalidOperationException("store down");
    public Task AppendToJournalAsync(string sid, FlowRun run, CancellationToken ct = default)
        => throw new InvalidOperationException("store down");
    public Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sid, CancellationToken ct = default)
        => throw new InvalidOperationException("store down");
}
public class FlowRecorderTests
{
    [Fact]
    public async Task Resume_stitches_two_halves_and_complete_appends_to_journal()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        var run = rec.BeginRun("auth.login", "Login", new[] { "Browser", "SessionManager" }, correlationKey: "state-1");
        rec.Step(run, "Generated PKCE pair", "SessionManager", "SessionManager",
                 new[] { TraceVariable.Plain("state", "state-1") });
        var resumed = rec.ResumeRun("state-1");
        Assert.NotNull(resumed);
        // The login-half step must survive the resume across a serializing store.
        Assert.Single(resumed!.Steps);
        Assert.Equal("Generated PKCE pair", resumed.Steps[0].Label);
        rec.Step(resumed!, "Tokens received", "Keycloak", "SessionManager",
                 new[] { TraceVariable.Jwt("access_token", "eyJ.a.b") });
        rec.Complete(resumed!, "session-1");
        var journal = await store.GetJournalAsync("session-1");
        Assert.Single(journal);
        Assert.Equal(2, journal[0].Steps.Count);
        Assert.Equal("Generated PKCE pair", journal[0].Steps[0].Label);
        Assert.Equal("Tokens received", journal[0].Steps[1].Label);
        Assert.Equal(FlowStatus.Completed, journal[0].Status);
    }

    [Fact]
    public void BeginRun_source_and_Step_short_seq_source_are_recorded()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        var run = rec.BeginRun("auth.login", "Login", new[] { "Browser", "SessionManager" }, source: "bff");
        Assert.Equal("bff", run.Source);

        rec.Step(run, "Generated PKCE pair", "SessionManager", "SessionManager",
                 new[] { TraceVariable.Plain("state", "s") }, shortLabel: "PKCE");
        rec.Step(run, "Redirect to Keycloak", "SessionManager", "Browser",
                 Array.Empty<TraceVariable>(), shortLabel: "Redirect");
        rec.Step(run, "Tokens received", "Keycloak", "SessionManager",
                 Array.Empty<TraceVariable>(), shortLabel: "Tokens");

        Assert.Equal(3, run.Steps.Count);

        Assert.Equal("PKCE", run.Steps[0].Short);
        Assert.Equal("bff", run.Steps[0].Source);
        Assert.Equal(1, run.Steps[0].Seq);

        Assert.Equal("Redirect", run.Steps[1].Short);
        Assert.Equal("bff", run.Steps[1].Source);
        Assert.Equal(2, run.Steps[1].Seq);

        Assert.Equal("Tokens", run.Steps[2].Short);
        Assert.Equal("bff", run.Steps[2].Source);
        Assert.Equal(3, run.Steps[2].Seq);
    }

    [Fact]
    public async Task Fail_persists_failed_status_and_error_to_store()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        var run = rec.BeginRun("auth.login", "Login", new[] { "Browser", "SessionManager" }, correlationKey: "state-2");
        rec.Step(run, "Generated PKCE pair", "SessionManager", "SessionManager",
                 new[] { TraceVariable.Plain("state", "state-2") });
        rec.Fail(run, "boom");
        // Run was begun with a correlationKey, so it is persisted under that key (not run.Id).
        var stored = await store.GetRunAsync("state-2");
        Assert.NotNull(stored);
        Assert.Equal(FlowStatus.Failed, stored!.Status);
        Assert.Equal("boom", stored.Error);
    }

    [Fact]
    public void Store_errors_never_propagate_into_the_host_flow()
    {
        // Instrumentation is best-effort observability: a failing ITraceStore (Redis timeout,
        // Data Protection key rotation, disconnect) MUST NOT break the host's real flows.
        var rec = new FlowRecorder(new ThrowingTraceStore());

        FlowRun run = null!;
        var beginEx = Record.Exception(() =>
            run = rec.BeginRun("auth.login", "Login", new[] { "Browser", "SessionManager" }, correlationKey: "state-x"));
        Assert.Null(beginEx);
        Assert.NotNull(run);

        var stepEx = Record.Exception(() =>
            rec.Step(run, "Generated PKCE pair", "SessionManager", "SessionManager",
                     new[] { TraceVariable.Plain("state", "state-x") }));
        Assert.Null(stepEx);
        // In-memory mutation still happened even though persistence threw.
        Assert.Single(run.Steps);

        var completeEx = Record.Exception(() => rec.Complete(run, "session-x"));
        Assert.Null(completeEx);
        Assert.Equal(FlowStatus.Completed, run.Status);

        var failEx = Record.Exception(() => rec.Fail(run, "boom"));
        Assert.Null(failEx);
        Assert.Equal(FlowStatus.Failed, run.Status);
        Assert.Equal("boom", run.Error);

        // ResumeRun swallows the store error and returns null instead of throwing.
        FlowRun? resumed = null;
        var resumeEx = Record.Exception(() => resumed = rec.ResumeRun("state-x"));
        Assert.Null(resumeEx);
        Assert.Null(resumed);
    }
}
