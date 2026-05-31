using Microsoft.AspNetCore.Http;
namespace TokenInspect.AspNetCore;

/// <summary>
/// <see cref="DelegatingHandler"/> that records downstream HTTP calls onto the current request's
/// <see cref="FlowRun"/> (stashed by <see cref="TokenInspectMiddleware"/> in
/// <c>HttpContext.Items["__ti_run"]</c>). It NEVER mutates the outgoing request and swallows all
/// recording errors so it cannot break the host's downstream call.
/// </summary>
public sealed class DownstreamHandler : DelegatingHandler
{
    private readonly IHttpContextAccessor _accessor;

    public DownstreamHandler(IHttpContextAccessor accessor) => _accessor = accessor;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // Capture request metadata WITHOUT touching/mutating the request.
        var run = CurrentRun();
        TryAppendCall(run, request);

        var response = await base.SendAsync(request, cancellationToken);

        TryAppendResponse(run, response);
        return response;
    }

    private FlowRun? CurrentRun()
    {
        try
        {
            var items = _accessor.HttpContext?.Items;
            if (items is not null && items.TryGetValue(TokenInspectMiddleware.RunItemKey, out var v) && v is FlowRun run)
                return run;
        }
        catch { /* best-effort */ }
        return null;
    }

    private static void TryAppendCall(FlowRun? run, HttpRequestMessage request)
    {
        if (run is null) return;
        try
        {
            var ordinal = run.Steps.Count;
            run.Steps.Add(new TraceStep(
                Ordinal: ordinal,
                Label: "Downstream call",
                From: "API",
                To: "Core",
                Timestamp: DateTimeOffset.UtcNow,
                Vars: new[]
                {
                    TraceVariable.Plain("method", request.Method.Method),
                    TraceVariable.Url("url", request.RequestUri?.ToString() ?? string.Empty),
                },
                Source: "server"));
        }
        catch { /* recording is best-effort */ }
    }

    private static void TryAppendResponse(FlowRun? run, HttpResponseMessage response)
    {
        if (run is null) return;
        try
        {
            var ordinal = run.Steps.Count;
            run.Steps.Add(new TraceStep(
                Ordinal: ordinal,
                Label: "Response",
                From: "Core",
                To: "API",
                Timestamp: DateTimeOffset.UtcNow,
                Vars: new[]
                {
                    TraceVariable.Plain("status", ((int)response.StatusCode).ToString()),
                },
                Source: "server"));
        }
        catch { /* recording is best-effort */ }
    }
}
