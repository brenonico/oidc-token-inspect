using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Generic drop-in middleware that records a per-request <see cref="FlowRun"/> into a bounded
/// in-memory ring. Pure no-op when <see cref="AspNetCoreOptions.Enabled"/> is false. Never alters
/// the response, never changes status/body, and never throws on its own account (all recording is
/// best-effort and swallowed).
/// </summary>
public sealed class TokenInspectMiddleware
{
    /// <summary>Key under which the current run is stashed in <see cref="HttpContext.Items"/> so the
    /// <see cref="DownstreamHandler"/> can append steps to it.</summary>
    public const string RunItemKey = "__ti_run";

    private readonly RequestDelegate _next;
    private readonly AspNetCoreOptions _opts;
    private readonly RingBuffer<FlowRun> _ring;

    public TokenInspectMiddleware(RequestDelegate next, IOptions<AspNetCoreOptions> opts, RingBuffer<FlowRun> ring)
    {
        _next = next;
        _opts = opts.Value;
        _ring = ring;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        // CLOSED DOOR: pure pass-through, zero ring writes, zero allocations of our own.
        if (!_opts.Enabled)
        {
            await _next(ctx);
            return;
        }

        // Read + sanitize the correlation id from the (untrusted) header. Anti log/cache injection:
        // anything not matching the strict allow-list is discarded and a server-side id generated.
        string? headerValue = ctx.Request.Headers[_opts.CorrelationHeader].ToString();
        var correlationId = CorrelationId.Sanitize(string.IsNullOrEmpty(headerValue) ? null : headerValue);

        FlowRun? run = null;
        try
        {
            run = new FlowRun
            {
                FlowKind = "api.server",
                Title = $"{ctx.Request.Method} {ctx.Request.Path}",
                Source = "server",
                CorrelationId = correlationId,
                Participants = new[] { "API", "RBAC", "Core" },
            };
            ctx.Items[RunItemKey] = run;
        }
        catch
        {
            // Recording setup must never break the host.
            run = null;
        }

        try
        {
            await _next(ctx);
            if (run is not null)
            {
                run.Status = FlowStatus.Completed;
                run.EndedAt = DateTimeOffset.UtcNow;
            }
        }
        catch (Exception ex)
        {
            if (run is not null)
            {
                run.Status = FlowStatus.Failed;
                run.Error = ex.GetType().Name; // type only — never the full message/PII
                run.EndedAt = DateTimeOffset.UtcNow;
            }
            throw; // do not swallow the host's exception
        }
        finally
        {
            if (run is not null)
            {
                try { _ring.Append(run); } catch { /* recording is best-effort */ }
            }
        }
    }
}

public static class TokenInspectMiddlewareExtensions
{
    /// <summary>Registers <see cref="AspNetCoreOptions"/> and the singleton <see cref="RingBuffer{FlowRun}"/>.</summary>
    public static IServiceCollection AddTokenInspectAspNetCore(this IServiceCollection services, Action<AspNetCoreOptions>? configure = null)
    {
        var probe = new AspNetCoreOptions();
        configure?.Invoke(probe);
        if (configure is not null)
            services.Configure<AspNetCoreOptions>(configure);

        // Capacity/TTL are fixed at registration from the probed options (singleton ring).
        services.AddSingleton(new RingBuffer<FlowRun>(probe.RingCapacity, probe.Ttl));
        // IHttpContextAccessor is needed by DownstreamHandler if the host wires it.
        services.AddHttpContextAccessor();
        return services;
    }

    /// <summary>Adds the recording middleware. No-op at runtime when disabled.</summary>
    public static IApplicationBuilder UseTokenInspect(this IApplicationBuilder app)
        => app.UseMiddleware<TokenInspectMiddleware>();
}
