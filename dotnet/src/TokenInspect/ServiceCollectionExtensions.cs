using Microsoft.Extensions.DependencyInjection;
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
        return services;
    }
}
