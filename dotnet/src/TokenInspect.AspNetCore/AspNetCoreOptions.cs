using Microsoft.AspNetCore.Http;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Options for the generic <c>app.UseTokenInspect()</c> middleware + dev endpoint.
/// Secure-by-default: the feature is OFF, the dev endpoint denies everything, is
/// loopback-only, and never trusts request-supplied identity for ownership.
/// </summary>
public sealed class AspNetCoreOptions
{
    /// <summary>Master switch. Default OFF. When false the middleware is a pure pass-through
    /// no-op and the dev endpoint is not mapped (404).</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>Production fail-safe acknowledgement. In <see cref="Microsoft.Extensions.Hosting.IHostEnvironment"/>
    /// Production, the dev endpoint (which can surface token/claim material) is NOT exposed unless this
    /// is explicitly set to true. A noisy warning is logged at startup either way.</summary>
    public bool AckExposesTokens { get; set; } = false;

    /// <summary>Path of the read-only dev endpoint. Intentionally obscure / tool-neutral.</summary>
    public string EndpointPath { get; set; } = "/__ti/trace";

    /// <summary>When true (default) the dev endpoint only answers requests whose remote IP is a loopback
    /// address; non-loopback callers get 404 so the endpoint is not even advertised.</summary>
    public bool LoopbackOnly { get; set; } = true;

    /// <summary>Header carrying the cross-source correlation id. Default is the W3C-neutral
    /// <c>traceparent</c> — NEVER a header that identifies this tool. The value is sanitized
    /// before any use as a log/ring key.</summary>
    public string CorrelationHeader { get; set; } = "traceparent";

    /// <summary>Maximum number of <see cref="FlowRun"/>s retained in the in-memory ring.</summary>
    public int RingCapacity { get; set; } = 256;

    /// <summary>Time-to-live for ring entries; expired entries are evicted on read.</summary>
    public TimeSpan Ttl { get; set; } = TimeSpan.FromMinutes(15);

    /// <summary>
    /// REQUIRED for the dev endpoint to return data. Receives the <see cref="HttpContext"/> and the
    /// correlation id pulled from the query, returns true ONLY if the authenticated caller is allowed
    /// to read that run. Default: DENY EVERYTHING. The host wires this to a principal-derived check —
    /// ownership is derived from the authenticated context, NEVER from a request header.
    /// </summary>
    public Func<HttpContext, string, bool> Authorize { get; set; } = static (_, _) => false;
}
