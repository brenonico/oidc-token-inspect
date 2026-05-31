using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using TokenInspect;
using Xunit;

// ---------------------------------------------------------------------------
// Fake ITraceStore for endpoint tests
// ---------------------------------------------------------------------------
file sealed class EndpointTestStore : ITraceStore
{
    public ConcurrentDictionary<string, FlowRun> Runs = new();
    public ConcurrentDictionary<string, List<FlowRun>> Journals = new();

    public Task SaveRunAsync(string key, FlowRun run, CancellationToken ct = default)
    { Runs[key] = run; return Task.CompletedTask; }

    public Task<FlowRun?> GetRunAsync(string key, CancellationToken ct = default)
        => Task.FromResult(Runs.GetValueOrDefault(key));

    public Task AppendToJournalAsync(string sid, FlowRun run, CancellationToken ct = default)
    { Journals.GetOrAdd(sid, _ => new()).Add(run); return Task.CompletedTask; }

    public Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sid, CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<FlowRun>>(Journals.GetValueOrDefault(sid) ?? new List<FlowRun>());
}

// ---------------------------------------------------------------------------
// Helper: build a TestServer-backed HttpClient for a given options configuration
// ---------------------------------------------------------------------------
file static class TestServerHelper
{
    public static HttpClient BuildClient(
        Action<TokenInspectOptions> configureOptions,
        Action<EndpointTestStore>? seedStore = null)
    {
        var store = new EndpointTestStore();
        seedStore?.Invoke(store);

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddTokenInspect(configureOptions);
        builder.Services.AddSingleton<ITraceStore>(store);

        var app = builder.Build();
        app.MapTokenInspect();
        app.StartAsync().GetAwaiter().GetResult();

        return app.GetTestClient();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
public class TokenInspectEndpointsTests
{
    // Case 1: Enabled=false → route not mapped → 404
    [Fact]
    public async Task Disabled_returns_404()
    {
        using var client = TestServerHelper.BuildClient(o => o.Enabled = false);
        var response = await client.GetAsync("/internal/trace");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // Case 2: Enabled=true, no X-Session-Id → 401
    [Fact]
    public async Task Enabled_without_session_header_returns_401()
    {
        using var client = TestServerHelper.BuildClient(o => o.Enabled = true);
        var response = await client.GetAsync("/internal/trace");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // Case 3: Enabled=true, with X-Session-Id 's1' but Authorize NOT set (default-deny) → 403.
    // Possession of the header alone is NOT proof of ownership; the default delegate denies all.
    [Fact]
    public async Task Enabled_with_session_header_but_default_deny_returns_403()
    {
        using var client = TestServerHelper.BuildClient(o => o.Enabled = true);

        var request = new HttpRequestMessage(HttpMethod.Get, "/internal/trace");
        request.Headers.Add("X-Session-Id", "s1");
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // Case 4: Enabled=true, X-Session-Id 's1', Authorize approves only 's1' → 200, body
    // contains s1's journal and does NOT leak s2's data (principal-derived scoping).
    [Fact]
    public async Task Enabled_with_authorize_allowing_session_returns_200_with_correct_journal()
    {
        using var client = TestServerHelper.BuildClient(
            o =>
            {
                o.Enabled = true;
                o.Authorize = (_, sid) => ValueTask.FromResult(sid == "s1");
            },
            seedStore: store =>
            {
                var run = new FlowRun { FlowKind = "auth.login", Title = "Login", Participants = new[] { "Browser" } };
                store.Journals["s1"] = new List<FlowRun> { run };
                // also put something under a different key to verify scoping
                var other = new FlowRun { FlowKind = "auth.login", Title = "Other", Participants = new[] { "X" } };
                store.Journals["s2"] = new List<FlowRun> { other };
            });

        var request = new HttpRequestMessage(HttpMethod.Get, "/internal/trace");
        request.Headers.Add("X-Session-Id", "s1");
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("s1", body);
        Assert.DoesNotContain("Other", body); // s2's data must NOT leak
    }
}
