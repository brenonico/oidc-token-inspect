using Microsoft.AspNetCore.Builder;
namespace TokenInspect.AspNetCore;

/// <summary>Pipeline extensions for the <see cref="InspectFlowMiddleware"/>.</summary>
public static class InspectFlowApplicationBuilderExtensions
{
    /// <summary>
    /// Adds the <see cref="InspectFlowMiddleware"/>. Place it after <c>UseRouting()</c> and before
    /// <c>UseEndpoints()</c> so the matched endpoint and its <see cref="InspectFlowMetadata"/> are
    /// available; in a minimal-API pipeline add it anywhere before the endpoint executes.
    /// </summary>
    public static IApplicationBuilder UseInspectFlow(this IApplicationBuilder app)
        => app.UseMiddleware<InspectFlowMiddleware>();
}
