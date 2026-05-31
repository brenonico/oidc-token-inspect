using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
namespace TokenInspect;
public static class TokenInspectEndpoints
{
    public static IEndpointRouteBuilder MapTokenInspect(this IEndpointRouteBuilder app)
    {
        var opts = app.ServiceProvider.GetRequiredService<IOptions<TokenInspectOptions>>().Value;
        if (!opts.Enabled) return app; // CLOSED DOOR: route doesn't even exist

        app.MapGet("/internal/trace", async (HttpContext ctx, ITraceStore store, IOptions<TokenInspectOptions> o, CancellationToken ct) =>
        {
            var options = o.Value;
            var sessionId = ctx.Request.Headers[options.SessionIdHeader].ToString();
            if (string.IsNullOrEmpty(sessionId)) return Results.Unauthorized();
            if (!await options.Authorize(ctx, sessionId)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var journal = await store.GetJournalAsync(sessionId, ct);
            return Results.Ok(new { sessionId, runs = journal });
        }).WithTags("token-inspect");

        return app;
    }
}
