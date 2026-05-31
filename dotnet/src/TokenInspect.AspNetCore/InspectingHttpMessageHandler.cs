using System.Net.Http.Headers;
using System.Text;
namespace TokenInspect.AspNetCore;

/// <summary>
/// <see cref="DelegatingHandler"/> that records a request step and a response step onto the ambient
/// <see cref="InspectFlow"/> scope for each outgoing call, removing the need to call
/// <see cref="InspectFlow.Step"/> by hand for every upstream hop. When no scope is open it is a pure
/// pass-through. It never mutates the outgoing request: headers are redacted on a throwaway copy, and
/// body previews are read only from buffered content (request) or from the already-buffered response.
/// </summary>
public sealed class InspectingHttpMessageHandler : DelegatingHandler
{
    private readonly InspectingHandlerOptions _opts;

    /// <summary>Creates the handler with the options that govern actor names, redaction, and body capture.</summary>
    public InspectingHttpMessageHandler(InspectingHandlerOptions opts) => _opts = opts;

    /// <inheritdoc />
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (InspectFlow.Current is null)
            return await base.SendAsync(request, cancellationToken);

        var requestVars = await BuildRequestVarsAsync(request, cancellationToken);
        InspectFlow.Step(
            $"{request.Method} {request.RequestUri?.AbsolutePath}",
            _opts.FromActor, _opts.ToActor, requestVars);

        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken);
        }
        catch (Exception ex)
        {
            InspectFlow.Step(
                $"Error: {ex.GetType().Name}",
                _opts.FromActor, _opts.ToActor,
                [TraceVariable.Plain("error", ex.Message)]);
            throw;
        }

        var responseVars = await BuildResponseVarsAsync(response, cancellationToken);
        InspectFlow.Step(
            $"Response {(int)response.StatusCode}",
            _opts.ToActor, _opts.FromActor, responseVars);

        return response;
    }

    private async Task<IReadOnlyList<TraceVariable>> BuildRequestVarsAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var vars = new List<TraceVariable>
        {
            TraceVariable.Plain("method", request.Method.Method),
            TraceVariable.Url("url", request.RequestUri?.ToString() ?? string.Empty),
        };
        vars.AddRange(HeaderVars(request.Headers, new HttpRequestMessage().Headers));

        // Only buffered content (ByteArrayContent and its subclasses StringContent/FormUrlEncodedContent)
        // is re-readable, so reading a preview here cannot consume the body the inner handler will send.
        if (_opts.IncludeRequestBody && request.Content is ByteArrayContent)
        {
            var preview = await ReadPreviewAsync(request.Content, ct);
            if (preview is not null)
                vars.Add(TraceVariable.Plain("body", preview));
        }
        return vars;
    }

    private async Task<IReadOnlyList<TraceVariable>> BuildResponseVarsAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var vars = new List<TraceVariable>
        {
            TraceVariable.Plain("status", ((int)response.StatusCode).ToString()),
        };
        vars.AddRange(HeaderVars(response.Headers, new HttpResponseMessage().Headers));

        // ReadAsByteArrayAsync buffers the content, so the consumer can still read the response body.
        if (_opts.IncludeResponseBody && response.Content is not null)
        {
            var preview = await ReadPreviewAsync(response.Content, ct);
            if (preview is not null)
                vars.Add(TraceVariable.Plain("body", preview));
        }
        return vars;
    }

    private List<TraceVariable> HeaderVars(HttpHeaders source, HttpHeaders sink)
    {
        foreach (var header in source)
            sink.TryAddWithoutValidation(header.Key, header.Value);
        _opts.Redact?.Invoke(sink);

        var vars = new List<TraceVariable>();
        foreach (var header in sink)
            vars.Add(TraceVariable.Plain(header.Key, string.Join(", ", header.Value)));
        return vars;
    }

    private async Task<string?> ReadPreviewAsync(HttpContent content, CancellationToken ct)
    {
        var bytes = await content.ReadAsByteArrayAsync(ct);
        if (bytes.Length == 0)
            return string.Empty;
        var take = Math.Min(bytes.Length, _opts.BodyPreviewBytes);
        return Encoding.UTF8.GetString(bytes, 0, take);
    }
}
