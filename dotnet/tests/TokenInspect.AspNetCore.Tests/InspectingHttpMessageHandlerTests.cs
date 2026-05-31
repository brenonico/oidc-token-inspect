using System.Net;
using System.Net.Http.Headers;
using Microsoft.Extensions.DependencyInjection;
using TokenInspect;
using TokenInspect.AspNetCore;
using Xunit;

// Minimal recorder: mirrors the real recorder's in-memory mutations so tests can read steps straight
// off the FlowRun, without a store. Matches the pattern used in TokenInspect.Tests.
file sealed class RecordingFlowRecorder : IFlowRecorder
{
    private readonly object _gate = new();

    public FlowRun BeginRun(string flowKind, string title, IReadOnlyList<string> participants, string? correlationKey = null, string? source = null)
        => new() { FlowKind = flowKind, Title = title, Participants = participants, CorrelationKey = correlationKey, Source = source };

    public FlowRun? ResumeRun(string correlationKey) => null;

    public void Step(FlowRun run, string label, string from, string to, IReadOnlyList<TraceVariable> vars, string? note = null, string? shortLabel = null)
    {
        lock (_gate)
            run.Steps.Add(new TraceStep(run.Steps.Count + 1, label, from, to, default, vars, note, shortLabel));
    }

    public void Complete(FlowRun run, string sessionId) => run.Status = FlowStatus.Completed;

    public void Fail(FlowRun run, string error)
    {
        run.Status = FlowStatus.Failed;
        run.Error = error;
    }
}

// Innermost handler under test: returns a canned response (or throws), and counts invocations.
file sealed class StubHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
    public int Calls { get; private set; }

    public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) => _responder = responder;
    public StubHandler(HttpResponseMessage response) : this(_ => response) { }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++;
        return Task.FromResult(_responder(request));
    }
}

public class InspectingHttpMessageHandlerTests : IDisposable
{
    public InspectingHttpMessageHandlerTests() => InspectFlowConfig.Recorder = new RecordingFlowRecorder();
    public void Dispose() => InspectFlowConfig.Recorder = null;

    private static HttpClient Client(InspectingHandlerOptions opts, HttpMessageHandler inner)
        => new(new InspectingHttpMessageHandler(opts) { InnerHandler = inner });

    private static HttpResponseMessage Ok(string? body = null) => new(HttpStatusCode.OK)
    {
        Content = body is null ? new StringContent(string.Empty) : new StringContent(body),
    };

    [Fact]
    public async Task OutsideScope_PassesThrough_NoSteps()
    {
        Assert.Null(InspectFlow.Current);
        var stub = new StubHandler(Ok());
        using var client = Client(new InspectingHandlerOptions(), stub);

        var response = await client.GetAsync("https://api.example/widgets");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, stub.Calls);
        Assert.Null(InspectFlow.Current);
    }

    [Fact]
    public async Task InsideScope_Records_Request_And_Response_Steps()
    {
        var stub = new StubHandler(Ok());
        using var client = Client(new InspectingHandlerOptions { FromActor = "SessionManager", ToActor = "Keycloak" }, stub);

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await client.GetAsync("https://kc.example/realms/x/protocol/openid-connect/token?foo=bar");

        Assert.Equal(2, flow.Run.Steps.Count);

        var request = flow.Run.Steps[0];
        Assert.Equal("GET /realms/x/protocol/openid-connect/token", request.Label);
        Assert.Equal("SessionManager", request.From);
        Assert.Equal("Keycloak", request.To);
        Assert.Equal("GET", request.Vars.Single(v => v.Name == "method").Value);
        Assert.Contains("foo=bar", request.Vars.Single(v => v.Name == "url").Value);

        var resp = flow.Run.Steps[1];
        Assert.Equal("Response 200", resp.Label);
        Assert.Equal("Keycloak", resp.From);
        Assert.Equal("SessionManager", resp.To);
        Assert.Equal("200", resp.Vars.Single(v => v.Name == "status").Value);
    }

    [Fact]
    public async Task Redaction_Removes_Authorization_Header_By_Default()
    {
        var stub = new StubHandler(Ok());
        using var client = Client(new InspectingHandlerOptions(), stub);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "secret-token");
        client.DefaultRequestHeaders.Add("X-Trace", "keep-me");

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await client.GetAsync("https://api.example/widgets");

        var request = flow.Run.Steps[0];
        Assert.DoesNotContain(request.Vars, v => string.Equals(v.Name, "Authorization", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(request.Vars, v => v.Name == "X-Trace");
    }

    [Fact]
    public async Task Custom_Redaction_Replaces_Default()
    {
        var opts = new InspectingHandlerOptions
        {
            Redact = headers => headers.Remove("X-Secret"),
        };
        var stub = new StubHandler(Ok());
        using var client = Client(opts, stub);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "secret-token");
        client.DefaultRequestHeaders.Add("X-Secret", "hide-me");

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await client.GetAsync("https://api.example/widgets");

        var request = flow.Run.Steps[0];
        // Custom redaction replaced the default, so Authorization survives and X-Secret is gone.
        Assert.Contains(request.Vars, v => string.Equals(v.Name, "Authorization", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(request.Vars, v => v.Name == "X-Secret");
    }

    [Fact]
    public async Task RequestBody_Recorded_When_Enabled_And_Truncated_To_PreviewBytes()
    {
        var opts = new InspectingHandlerOptions { IncludeRequestBody = true, BodyPreviewBytes = 10 };
        var stub = new StubHandler(Ok());
        using var client = Client(opts, stub);

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        var content = new StringContent(new string('a', 100));
        await client.PostAsync("https://api.example/widgets", content);

        var body = flow.Run.Steps[0].Vars.Single(v => v.Name == "body");
        Assert.Equal(10, body.Value.Length);
        Assert.Equal(new string('a', 10), body.Value);
    }

    [Fact]
    public async Task ResponseBody_Recorded_When_Enabled()
    {
        var opts = new InspectingHandlerOptions { IncludeResponseBody = true };
        var stub = new StubHandler(Ok("hello-from-upstream"));
        using var client = Client(opts, stub);

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await client.GetAsync("https://api.example/widgets");

        var body = flow.Run.Steps[1].Vars.Single(v => v.Name == "body");
        Assert.Equal("hello-from-upstream", body.Value);
    }

    [Fact]
    public async Task ServerError_5xx_Still_Records_Response_Step()
    {
        var stub = new StubHandler(new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("boom") });
        using var client = Client(new InspectingHandlerOptions(), stub);

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await client.GetAsync("https://api.example/widgets");

        Assert.Equal(2, flow.Run.Steps.Count);
        var resp = flow.Run.Steps[1];
        Assert.Equal("Response 500", resp.Label);
        Assert.Equal("500", resp.Vars.Single(v => v.Name == "status").Value);
    }

    [Fact]
    public async Task Exception_Records_Error_Step_And_Rethrows()
    {
        var stub = new StubHandler(_ => throw new HttpRequestException("connection refused"));
        using var client = Client(new InspectingHandlerOptions { FromActor = "SessionManager", ToActor = "Keycloak" }, stub);

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync("https://api.example/widgets"));

        // Request step plus an error step; no response step.
        Assert.Equal(2, flow.Run.Steps.Count);
        var error = flow.Run.Steps[1];
        Assert.Equal("Error: HttpRequestException", error.Label);
        Assert.Equal("SessionManager", error.From);
        Assert.Equal("Keycloak", error.To);
    }

    [Fact]
    public async Task AddInspectingHandler_Wires_Named_Options_And_Records()
    {
        var services = new ServiceCollection();
        services.AddHttpClient("kc")
            .AddInspectingHandler(o => { o.FromActor = "SessionManager"; o.ToActor = "Keycloak"; })
            .ConfigurePrimaryHttpMessageHandler(() => new StubHandler(Ok()));
        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();

        using var flow = InspectFlow.Begin("upstream.call", "Call");
        var client = factory.CreateClient("kc");
        await client.GetAsync("https://kc.example/token");

        Assert.Equal(2, flow.Run.Steps.Count);
        Assert.Equal("SessionManager", flow.Run.Steps[0].From);
        Assert.Equal("Keycloak", flow.Run.Steps[0].To);
    }
}
