using System.Net;
using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using TokenInspect;
using TokenInspect.AspNetCore;
using Xunit;

namespace TokenInspect.AspNetCore.Tests;

// Captures every recorder call into thread-safe lists so tests can assert run lifecycle and
// AsyncLocal isolation off the FlowRun, without depending on FlowRecorder or a store. Mirrors the
// real recorder's in-memory mutations (appends steps, sets status).
internal sealed class CapturingFlowRecorder : IFlowRecorder
{
    private readonly object _gate = new();
    public List<FlowRun> Runs { get; } = new();
    public List<(FlowRun run, string sessionId)> Completed { get; } = new();
    public List<(FlowRun run, string error)> Failed { get; } = new();

    public FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null)
    {
        var run = new FlowRun
        {
            FlowKind = flowKind,
            Title = title,
            Participants = participants,
            CorrelationKey = correlationKey,
            Source = source,
        };
        lock (_gate) Runs.Add(run);
        return run;
    }

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

file static class TestApp
{
    // Builds a TestServer-backed app with the InspectFlow middleware placed after routing. A
    // non-Development environment keeps the developer exception page out of the pipeline, so a
    // throwing handler propagates instead of being turned into a 500.
    public static (WebApplication app, HttpClient client) Build(
        Action<IEndpointRouteBuilder> map,
        Action<IApplicationBuilder>? beforeFlow = null)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.WebHost.UseTestServer();
        builder.Services.AddRouting();

        var app = builder.Build();
        app.UseRouting();
        beforeFlow?.Invoke(app);
        app.UseInspectFlow();
        map(app);

        app.StartAsync().GetAwaiter().GetResult();
        return (app, app.GetTestClient());
    }
}

public sealed class InspectFlowMiddlewareTests : IDisposable
{
    private readonly CapturingFlowRecorder _recorder = new();

    public InspectFlowMiddlewareTests() => InspectFlowConfig.Recorder = _recorder;
    public void Dispose() => InspectFlowConfig.Recorder = null;

    [Fact]
    public async Task Endpoint_Without_Metadata_Is_NoOp()
    {
        var (app, client) = TestApp.Build(e => e.MapGet("/plain", () => Results.Ok("ok")));
        try
        {
            var response = await client.GetAsync("/plain");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            Assert.Empty(_recorder.Runs);
            Assert.Empty(_recorder.Completed);
            Assert.Empty(_recorder.Failed);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Endpoint_With_Metadata_Begins_And_Completes_On_2xx()
    {
        var (app, client) = TestApp.Build(e => e
            .MapGet("/stepup", () => Results.Ok("ok"))
            .WithInspectFlow("auth.stepup", "Step-up MFA", actors: new[] { "Browser", "BFF", "Keycloak" }));
        try
        {
            var response = await client.GetAsync("/stepup");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal("auth.stepup", run.FlowKind);
            Assert.Equal("Step-up MFA", run.Title);
            Assert.Equal(new[] { "Browser", "BFF", "Keycloak" }, run.Participants);
            Assert.Equal(FlowStatus.Completed, run.Status);

            Assert.Single(_recorder.Completed);
            Assert.Empty(_recorder.Failed);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Endpoint_With_Metadata_Fails_On_4xx_With_Reason_http_400()
    {
        var (app, client) = TestApp.Build(e => e
            .MapGet("/bad", () => Results.BadRequest("no"))
            .WithInspectFlow("auth.stepup", "Step-up MFA"));
        try
        {
            var response = await client.GetAsync("/bad");
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal(FlowStatus.Failed, run.Status);

            var failure = Assert.Single(_recorder.Failed);
            Assert.Equal("http_400", failure.error);
            Assert.Empty(_recorder.Completed);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Endpoint_With_Metadata_Fails_On_5xx()
    {
        var (app, client) = TestApp.Build(e => e
            .MapGet("/boom", () => Results.StatusCode(StatusCodes.Status500InternalServerError))
            .WithInspectFlow("auth.stepup", "Step-up MFA"));
        try
        {
            var response = await client.GetAsync("/boom");
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal(FlowStatus.Failed, run.Status);

            var failure = Assert.Single(_recorder.Failed);
            Assert.Equal("http_500", failure.error);
            Assert.Empty(_recorder.Completed);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Exception_In_Handler_Fails_And_Rethrows()
    {
        var (app, client) = TestApp.Build(e => e
            .MapGet("/throw", void () => throw new InvalidOperationException("body failed"))
            .WithInspectFlow("auth.stepup", "Step-up MFA"));
        try
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => client.GetAsync("/throw"));

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal(FlowStatus.Failed, run.Status);

            var failure = Assert.Single(_recorder.Failed);
            Assert.Equal("exception:InvalidOperationException", failure.error);
            Assert.Empty(_recorder.Completed);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task CorrelationId_Accessor_Is_Invoked()
    {
        const string sessionId = "sess-xyz-1234";
        var (app, client) = TestApp.Build(e => e
            .MapGet("/corr", () => Results.Ok("ok"))
            .WithInspectFlow("auth.stepup", "Step-up MFA",
                correlationIdAccessor: ctx => ctx.Request.Headers["X-Session"].ToString()));
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/corr");
            request.Headers.Add("X-Session", sessionId);
            var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal(sessionId, run.CorrelationKey);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Default_CorrelationId_Reads_Sid_Claim()
    {
        const string sid = "S-987654";
        var (app, client) = TestApp.Build(
            map: e => e.MapGet("/sid", () => Results.Ok("ok")).WithInspectFlow("auth.stepup", "Step-up MFA"),
            beforeFlow: a => a.Use((ctx, next) =>
            {
                ctx.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sid", sid) }, "test"));
                return next(ctx);
            }));
        try
        {
            var response = await client.GetAsync("/sid");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var run = Assert.Single(_recorder.Runs);
            Assert.Equal(sid, run.CorrelationKey);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }

    [Fact]
    public async Task Concurrent_Requests_Do_Not_Bleed()
    {
        const int count = 50;
        const int stepsPerRequest = 5;

        var (app, client) = TestApp.Build(e => e
            .MapGet("/work", (HttpContext ctx) =>
            {
                var id = ctx.Request.Query["id"].ToString();
                for (var i = 0; i < stepsPerRequest; i++)
                    InspectFlow.Step($"step {i}", id, "X");
                return Results.Ok();
            })
            .WithInspectFlow("work", "Work", correlationIdAccessor: ctx => ctx.Request.Query["id"].ToString()));
        try
        {
            var responses = await Task.WhenAll(
                Enumerable.Range(0, count).Select(i => client.GetAsync($"/work?id={i}")));
            Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));

            Assert.Equal(count, _recorder.Runs.Count);
            Assert.Equal(count, _recorder.Completed.Count);
            Assert.Empty(_recorder.Failed);

            var seen = new HashSet<string>();
            foreach (var run in _recorder.Runs)
            {
                Assert.Equal(stepsPerRequest, run.Steps.Count);
                // Every step in a run must originate from that run's own id, never a sibling's.
                Assert.All(run.Steps, s => Assert.Equal(run.CorrelationKey, s.From));
                Assert.True(seen.Add(run.CorrelationKey!), $"duplicate run for id {run.CorrelationKey}");
            }

            var expected = Enumerable.Range(0, count).Select(i => i.ToString()).ToHashSet();
            Assert.Equal(expected, seen);
        }
        finally { await app.StopAsync(); await app.DisposeAsync(); }
    }
}
