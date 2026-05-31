using Microsoft.AspNetCore.Http;
namespace TokenInspect.AspNetCore;

/// <summary>
/// Opens an ambient <see cref="InspectFlow"/> scope around endpoints that carry
/// <see cref="InspectFlowMetadata"/>. Endpoints without it pass through untouched. The scope
/// completes on a 2xx/3xx response, fails with <c>http_{status}</c> on 4xx/5xx, and fails with
/// <c>exception:{TypeName}</c> when the pipeline throws (the exception is rethrown unchanged).
/// </summary>
public sealed class InspectFlowMiddleware
{
    private readonly RequestDelegate _next;

    /// <summary>Creates the middleware over the next delegate in the pipeline.</summary>
    public InspectFlowMiddleware(RequestDelegate next) => _next = next;

    /// <summary>Reads the endpoint metadata and, when present, wraps the request in a flow scope.</summary>
    public async Task InvokeAsync(HttpContext context)
    {
        var metadata = context.GetEndpoint()?.Metadata.GetMetadata<InspectFlowMetadata>();
        if (metadata is null)
        {
            await _next(context);
            return;
        }

        using var scope = InspectFlow.Begin(
            metadata.Name,
            metadata.Summary,
            metadata.CorrelationIdAccessor?.Invoke(context),
            metadata.Actors);

        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            scope.Fail($"exception:{ex.GetType().Name}");
            throw;
        }

        var status = context.Response.StatusCode;
        if (status >= 400)
            scope.Fail($"http_{status}");
        else
            scope.Complete();
    }
}
