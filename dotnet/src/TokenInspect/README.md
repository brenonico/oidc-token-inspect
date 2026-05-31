# TokenInspect

Core library for the [Token Inspect](https://github.com/brenonico/oidc-token-inspect) plugin: a didactic token-flow inspector for OIDC/OAuth 2.0 applications.

This package provides:

- `IFlowRecorder`: the contract that host code calls to begin a flow run, append steps, and complete or fail it. Ships with a `NullFlowRecorder` (no-op, safe default) and an in-memory `FlowRecorder`.
- `ITraceStore`: the host-implemented persistence abstraction. The library never persists anything itself; the host wires Redis, a database, or in-memory.
- `MapTokenInspect()`: the egress endpoint extension. Returns the journal for the **authorized** principal only. The `Authorize` delegate defaults to deny; the host must opt in.

## Install

```bash
dotnet add package TokenInspect
```

## Basic use (host wiring)

```csharp
builder.Services.AddTokenInspect(opts =>
{
    opts.Enabled = !builder.Environment.IsProduction();
    opts.Authorize = (ctx, sessionId) =>
    {
        // Host-defined ownership check; never trust a request-supplied id.
        return ctx.Request.Cookies.TryGetValue("session", out var owned)
            && string.Equals(owned, sessionId, StringComparison.Ordinal);
    };
});

// Your ITraceStore implementation:
builder.Services.AddSingleton<ITraceStore, MyRedisTraceStore>();

var app = builder.Build();
app.MapTokenInspect();   // GET /internal/trace (gated by Authorize)
```

For an ASP.NET middleware that records server-side hops automatically (validation, RBAC, downstream calls), see [`TokenInspect.AspNetCore`](https://www.nuget.org/packages/TokenInspect.AspNetCore).

## Security

The package is inert until `Enabled = true`. The `Authorize` delegate defaults to **deny**: no host wiring, no access. See the [security model](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/security.md) for the full set of controls.

## License

MIT.
