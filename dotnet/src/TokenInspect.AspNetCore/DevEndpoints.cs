using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
namespace TokenInspect.AspNetCore;

public static class DevEndpoints
{
    /// <summary>
    /// Maps the read-only dev endpoint that surfaces recorded runs. Defence in depth:
    /// <list type="number">
    /// <item><b>Flag gate:</b> not mapped at all when <see cref="AspNetCoreOptions.Enabled"/> is false (404).</item>
    /// <item><b>Prod fail-safe:</b> in Production it is not mapped unless <see cref="AspNetCoreOptions.AckExposesTokens"/> is true; a noisy warning is always logged.</item>
    /// <item><b>Loopback only:</b> non-loopback callers get 404 when <see cref="AspNetCoreOptions.LoopbackOnly"/> (default).</item>
    /// <item><b>Default-deny ACL:</b> ownership comes from <see cref="AspNetCoreOptions.Authorize"/> (default denies all → 403).</item>
    /// <item><b>Sanitized key:</b> the query correlation id is validated before lookup (anti injection).</item>
    /// </list>
    /// </summary>
    public static IEndpointRouteBuilder MapTokenInspectDev(this IEndpointRouteBuilder app)
    {
        var sp = app.ServiceProvider;
        var opts = sp.GetRequiredService<IOptions<AspNetCoreOptions>>().Value;
        var env = sp.GetRequiredService<IHostEnvironment>();
        var logger = sp.GetService<ILoggerFactory>()?.CreateLogger("TokenInspect.AspNetCore.DevEndpoint");

        // (1) CLOSED DOOR: route doesn't even exist.
        if (!opts.Enabled) return app;

        // (2) PROD FAIL-SAFE.
        if (env.IsProduction() && !opts.AckExposesTokens)
        {
            logger?.LogWarning(
                "TokenInspect dev endpoint NOT mapped in Production: it can surface token/claim material. " +
                "Set AspNetCoreOptions.AckExposesTokens=true to opt in (NOT recommended for production).");
            return app;
        }
        if (env.IsProduction() && opts.AckExposesTokens)
        {
            logger?.LogWarning(
                "TokenInspect dev endpoint IS MAPPED in Production at {Path}. It can surface token/claim material. " +
                "This is gated by AckExposesTokens=true, loopback-only={Loopback}, and a default-deny Authorize delegate.",
                opts.EndpointPath, opts.LoopbackOnly);
        }

        app.MapGet(opts.EndpointPath, (HttpContext ctx, IOptions<AspNetCoreOptions> o, RingBuffer<FlowRun> ring) =>
        {
            var options = o.Value;

            // (3) LOOPBACK ONLY — return 404 so the endpoint is not advertised to remote callers.
            if (options.LoopbackOnly)
            {
                var remote = ctx.Connection.RemoteIpAddress;
                if (remote is null || !IPAddress.IsLoopback(remote))
                    return Results.NotFound();
            }

            // (5) Sanitize the lookup key BEFORE any use (anti log/cache injection).
            var rawId = ctx.Request.Query["id"].ToString();
            if (string.IsNullOrEmpty(rawId) || !CorrelationId.IsValid(rawId))
                return Results.BadRequest(new { error = "missing or invalid id" });
            var id = rawId; // validated

            // (4) DEFAULT-DENY ACL — ownership derived from the authenticated context, never the header.
            if (!options.Authorize(ctx, id))
                return Results.StatusCode(StatusCodes.Status403Forbidden);

            var runs = ring.Find(r => r.CorrelationId == id);
            return Results.Ok(new { correlationId = id, runs });
        });

        return app;
    }
}
