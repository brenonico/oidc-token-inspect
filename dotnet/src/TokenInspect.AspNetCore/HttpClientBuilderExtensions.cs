using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Registers <see cref="InspectingHttpMessageHandler"/> on a typed or named <see cref="HttpClient"/> so
/// every outgoing call records a step onto the ambient <see cref="InspectFlow"/> scope, if one is open.
/// </summary>
public static class HttpClientBuilderExtensions
{
    /// <summary>
    /// Adds an <see cref="InspectingHttpMessageHandler"/> to the client's handler pipeline. The
    /// <paramref name="configure"/> action is registered as a named option keyed on the client name, so
    /// each instrumented client gets its own <see cref="InspectingHandlerOptions"/>.
    /// </summary>
    public static IHttpClientBuilder AddInspectingHandler(
        this IHttpClientBuilder builder,
        Action<InspectingHandlerOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(configure);

        builder.Services.Configure(builder.Name, configure);
        return builder.AddHttpMessageHandler(sp =>
        {
            var opts = sp.GetRequiredService<IOptionsMonitor<InspectingHandlerOptions>>().Get(builder.Name);
            return new InspectingHttpMessageHandler(opts);
        });
    }
}
