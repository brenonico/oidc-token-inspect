using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
namespace TokenInspect;
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddTokenInspect(this IServiceCollection services, Action<TokenInspectOptions>? configure = null)
    {
        var probe = new TokenInspectOptions();
        configure?.Invoke(probe);
        if (configure is not null)
            services.Configure<TokenInspectOptions>(configure);
        if (probe.Enabled)
            services.AddSingleton<IFlowRecorder, FlowRecorder>();   // requires ITraceStore (host registers)
        else
            services.AddSingleton<IFlowRecorder, NullFlowRecorder>(); // "closes the door"
        services.WireInspectFlow();
        return services;
    }

    // Resolves the registered recorder once at host startup and publishes it to InspectFlowConfig so
    // the ambient InspectFlow API works without the host injecting IFlowRecorder anywhere itself.
    private static IServiceCollection WireInspectFlow(this IServiceCollection services)
    {
        services.AddSingleton<IHostedService, InspectFlowInitializer>();
        return services;
    }
}

internal sealed class InspectFlowInitializer(IServiceProvider services) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        InspectFlowConfig.Recorder = services.GetService<IFlowRecorder>();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
