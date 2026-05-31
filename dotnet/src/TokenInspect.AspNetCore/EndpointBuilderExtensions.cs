using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
namespace TokenInspect.AspNetCore;

/// <summary>Endpoint convention extensions that declare ambient flow instrumentation.</summary>
public static class EndpointBuilderExtensions
{
    /// <summary>
    /// Declares that this endpoint runs inside an <see cref="InspectFlow"/> scope. The
    /// <see cref="InspectFlowMiddleware"/> opens the scope before the endpoint executes and
    /// completes or fails it from the response status.
    /// </summary>
    /// <param name="builder">The endpoint to instrument.</param>
    /// <param name="name">Flow kind passed to <see cref="InspectFlow.Begin"/> (e.g. <c>"auth.stepup"</c>).</param>
    /// <param name="summary">Human-readable summary of the flow.</param>
    /// <param name="actors">Participants rendered in the sequence diagram.</param>
    /// <param name="correlationIdAccessor">
    /// Derives the correlation id from the request. Defaults to the <c>sid</c> claim of the
    /// authenticated principal.
    /// </param>
    public static IEndpointConventionBuilder WithInspectFlow(
        this IEndpointConventionBuilder builder,
        string name,
        string summary,
        IReadOnlyList<string>? actors = null,
        Func<HttpContext, string?>? correlationIdAccessor = null)
    {
        var metadata = new InspectFlowMetadata(name, summary, actors,
            correlationIdAccessor ?? DefaultCorrelationId);
        builder.WithMetadata(metadata);
        return builder;
    }

    private static string? DefaultCorrelationId(HttpContext context)
        => context.User.FindFirst("sid")?.Value;
}
