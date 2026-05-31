using Microsoft.AspNetCore.Http;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Endpoint metadata that opts an endpoint into ambient flow instrumentation. Attach it with
/// <see cref="EndpointBuilderExtensions.WithInspectFlow"/>; <see cref="InspectFlowMiddleware"/>
/// reads it after routing and opens an <see cref="InspectFlow"/> scope around the endpoint.
/// </summary>
public sealed class InspectFlowMetadata
{
    /// <summary>Flow kind passed to <see cref="InspectFlow.Begin"/> (e.g. <c>"auth.stepup"</c>).</summary>
    public string Name { get; }

    /// <summary>Human-readable summary of the flow.</summary>
    public string Summary { get; }

    /// <summary>Participants rendered in the sequence diagram. Empty when none were supplied.</summary>
    public IReadOnlyList<string> Actors { get; }

    /// <summary>
    /// Optional accessor invoked once per request to derive the run's correlation id from the
    /// <see cref="HttpContext"/>. Null leaves the run without a correlation id.
    /// </summary>
    public Func<HttpContext, string?>? CorrelationIdAccessor { get; }

    /// <summary>Creates metadata for a flow named <paramref name="name"/>.</summary>
    /// <param name="name">Flow kind passed to <see cref="InspectFlow.Begin"/>.</param>
    /// <param name="summary">Human-readable summary of the flow.</param>
    /// <param name="actors">Participants rendered in the sequence diagram.</param>
    /// <param name="correlationIdAccessor">Optional accessor that derives the correlation id from the request.</param>
    public InspectFlowMetadata(string name, string summary,
        IReadOnlyList<string>? actors = null,
        Func<HttpContext, string?>? correlationIdAccessor = null)
    {
        Name = name ?? throw new ArgumentNullException(nameof(name));
        Summary = summary ?? throw new ArgumentNullException(nameof(summary));
        Actors = actors ?? Array.Empty<string>();
        CorrelationIdAccessor = correlationIdAccessor;
    }
}
