using System.Net.Http.Headers;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Options for <see cref="InspectingHttpMessageHandler"/>. Controls the actor names recorded on each
/// step, which headers are redacted before recording, and whether (and how much of) request and
/// response bodies are captured as a preview.
/// </summary>
public sealed class InspectingHandlerOptions
{
    /// <summary>Actor recorded as the originator of the outgoing request (the "from" side of the request
    /// step and the "to" side of the response step). Defaults to <c>"Host"</c>.</summary>
    public string FromActor { get; set; } = "Host";

    /// <summary>Actor recorded as the upstream target (the "to" side of the request step and the "from"
    /// side of the response step). Defaults to <c>"Upstream"</c>.</summary>
    public string ToActor { get; set; } = "Upstream";

    /// <summary>
    /// Applied to a throwaway copy of the request and response headers before they are recorded; it never
    /// touches the real outgoing request. Defaults to <see cref="DefaultRedact"/>, which strips
    /// <c>Authorization</c>, <c>Cookie</c>, <c>Set-Cookie</c>, and <c>Proxy-Authorization</c>. Set to a
    /// different delegate to replace the default, or <c>null</c> to record every header verbatim.
    /// </summary>
    public Action<HttpHeaders>? Redact { get; set; } = DefaultRedact;

    /// <summary>When true, a UTF-8 preview of a buffered request body is recorded. Default false.</summary>
    public bool IncludeRequestBody { get; set; } = false;

    /// <summary>When true, a UTF-8 preview of the response body is recorded. Default false.</summary>
    public bool IncludeResponseBody { get; set; } = false;

    /// <summary>Maximum number of bytes read from a body before truncation when a preview is recorded.</summary>
    public int BodyPreviewBytes { get; set; } = 2048;

    private static readonly string[] SensitiveHeaders =
        ["Authorization", "Cookie", "Set-Cookie", "Proxy-Authorization"];

    /// <summary>Removes the headers that commonly carry credentials or session material.</summary>
    public static void DefaultRedact(HttpHeaders headers)
    {
        foreach (var name in SensitiveHeaders)
            headers.Remove(name);
    }
}
