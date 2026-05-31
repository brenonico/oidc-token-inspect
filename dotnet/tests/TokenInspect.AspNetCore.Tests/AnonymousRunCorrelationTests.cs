using System.Collections.Concurrent;
using System.Text.Json;
using TokenInspect;
using Xunit;

namespace TokenInspect.AspNetCore.Tests;

// Lock-backed in-memory store. Clones runs in and out (JSON round-trip) to mimic a real
// serializing store (e.g. Redis) that returns deep copies, not shared references, and
// implements RekeyRunAsync atomically (pop old, push new under one lock) so the atomicity
// test is meaningful.
file sealed class InMemoryTraceStore : ITraceStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, FlowRun> _runs = new();
    private readonly ConcurrentDictionary<string, List<FlowRun>> _journals = new();

    private static FlowRun Clone(FlowRun run) => JsonSerializer.Deserialize<FlowRun>(JsonSerializer.Serialize(run))!;

    public Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default)
    {
        lock (_gate) { _runs[key] = Clone(run); }
        return Task.CompletedTask;
    }

    public Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default)
    {
        lock (_gate) { return Task.FromResult(_runs.TryGetValue(key, out var r) ? Clone(r) : null); }
    }

    public Task RekeyRunAsync(string oldCorrelationId, string newCorrelationId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (_runs.Remove(oldCorrelationId, out var run))
                _runs[newCorrelationId] = run;
        }
        return Task.CompletedTask;
    }

    public Task AppendToJournalAsync(string sid, FlowRun run, CancellationToken ct = default)
    {
        _journals.GetOrAdd(sid, _ => new()).Add(Clone(run));
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sid, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<FlowRun>>(_journals.GetValueOrDefault(sid) ?? new List<FlowRun>());

    // Test-only: report under one lock which of the two keys are present, so a concurrent reader
    // can assert it never observes both or neither during a rekey.
    public (bool oldPresent, bool newPresent) Probe(string oldKey, string newKey)
    {
        lock (_gate) { return (_runs.ContainsKey(oldKey), _runs.ContainsKey(newKey)); }
    }
}

public class AnonymousRunCorrelationTests
{
    private static FlowRun SeedAnonymousRun(FlowRecorder rec, string anonId)
    {
        var run = rec.BeginRun("auth.login", "Login", new[] { "Browser", "SessionManager" },
                               correlationKey: anonId, source: "client");
        rec.Step(run, "Page loaded", "Browser", "Browser",
                 new[] { TraceVariable.Plain("anon", anonId) }, shortLabel: "Load");
        rec.Step(run, "Clicked login", "Browser", "SessionManager",
                 Array.Empty<TraceVariable>(), shortLabel: "Login");
        return run;
    }

    [Fact]
    public async Task Adopt_KnownAnonId_RekeysRun()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        SeedAnonymousRun(rec, "anon-1");

        var adopted = await rec.AdoptAnonymousRun("anon-1", "session-1",
            new Dictionary<string, string> { ["adoptedAt"] = "callback" });

        Assert.NotNull(adopted);
        // Re-keyed: gone from the anonymous key, present under the session id.
        Assert.Null(await store.GetRunAsync("anon-1"));
        Assert.NotNull(await store.GetRunAsync("session-1"));
        // Metadata merged into the run.
        Assert.NotNull(adopted!.Metadata);
        Assert.Equal("callback", adopted.Metadata!["adoptedAt"]);
    }

    [Fact]
    public async Task Adopt_UnknownAnonId_ReturnsNull()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);

        var adopted = await rec.AdoptAnonymousRun("never-seen", "session-1");

        Assert.Null(adopted);
        // No phantom run was created under the session id.
        Assert.Null(await store.GetRunAsync("session-1"));
    }

    [Fact]
    public async Task Adopt_PreservesStepOrder()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        SeedAnonymousRun(rec, "anon-2");

        var adopted = await rec.AdoptAnonymousRun("anon-2", "session-2");

        Assert.NotNull(adopted);
        Assert.Equal(2, adopted!.Steps.Count);
        Assert.Equal("Page loaded", adopted.Steps[0].Label);
        Assert.Equal("Clicked login", adopted.Steps[1].Label);

        var stored = await store.GetRunAsync("session-2");
        Assert.NotNull(stored);
        Assert.Equal(new[] { "Page loaded", "Clicked login" }, stored!.Steps.Select(s => s.Label));
    }

    [Fact]
    public async Task Rekey_IsAtomic()
    {
        var store = new InMemoryTraceStore();
        var run = new FlowRun { FlowKind = "auth.login", Title = "Login", Participants = new[] { "Browser" } };
        await store.SaveRunAsync("anon-3", run);

        // Continuously re-key back and forth on a background task so the run is always under
        // exactly one of the two keys; a non-atomic re-key (remove then add in separate locks)
        // would expose an instant where the reader sees neither key, or both.
        var rekeys = Task.Run(async () =>
        {
            for (var i = 0; i < 2_000; i++)
            {
                await store.RekeyRunAsync("anon-3", "session-3");
                await store.RekeyRunAsync("session-3", "anon-3");
            }
        });

        var bad = 0;
        var observations = 0;
        for (var i = 0; i < 50_000; i++)
        {
            var (oldPresent, newPresent) = store.Probe("anon-3", "session-3");
            if (oldPresent == newPresent) bad++; // never both, never neither
            observations++;
        }

        await rekeys;
        Assert.True(observations > 0);
        Assert.Equal(0, bad);
    }

    [Fact]
    public async Task Subsequent_Step_AfterAdopt_LandsUnderNewSessionId()
    {
        var store = new InMemoryTraceStore();
        var rec = new FlowRecorder(store);
        SeedAnonymousRun(rec, "anon-4");

        var adopted = await rec.AdoptAnonymousRun("anon-4", "session-4");
        Assert.NotNull(adopted);

        // A step recorded after adoption must persist under the new session id, not the old one.
        rec.Step(adopted!, "Tokens received", "Keycloak", "SessionManager",
                 new[] { TraceVariable.Jwt("access_token", "eyJ.a.b") }, shortLabel: "Tokens");

        Assert.Null(await store.GetRunAsync("anon-4"));
        var stored = await store.GetRunAsync("session-4");
        Assert.NotNull(stored);
        Assert.Equal(3, stored!.Steps.Count);
        Assert.Equal("Tokens received", stored.Steps[2].Label);
    }
}
