# TokenInspect.AspNetCore

Drop-in ASP.NET Core middleware for the [Token Inspect](https://github.com/brenonico/oidc-token-inspect) plugin. Records, per correlation id:

- the inbound token (kind, claims, validation result, RBAC decision),
- outbound HttpClient calls,
- timestamps and ordering.

Buffered in a bounded in-memory ring with TTL. Exposes a dev endpoint that the browser plugin fetches to merge server lanes with client lanes by `correlationId`.

## Install

```bash
dotnet add package TokenInspect.AspNetCore
```

## Basic use

```csharp
builder.Services.Configure<AspNetCoreOptions>(opts =>
{
    opts.Enabled = !builder.Environment.IsProduction();
    opts.AckExposesTokens = !builder.Environment.IsProduction();
    opts.LoopbackOnly = true;
    opts.Authorize = (ctx, id) => ctx.User?.Identity?.IsAuthenticated == true;
});

var app = builder.Build();
app.UseTokenInspect();        // records on every request
app.MapTokenInspectDev();     // GET /__ti/trace?id=... (gated by Authorize)
```

In the browser, point the [`@oidc-token-inspect/browser`](https://www.npmjs.com/package/@oidc-token-inspect/browser) plugin at the dev endpoint:

```ts
init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'api-validates-token',
  egress: { endpoint: '/__ti/trace' },
});
```

The browser injects a same-origin `traceparent` header on outgoing calls; the middleware reads it and the panel merges both lanes.

## Defaults you should not loosen

- `LoopbackOnly = true`. The dev endpoint binds to loopback only. Open it carefully if you must.
- `Authorize = (_, _) => false`. The host **must** provide a real check. Header-trust ACLs are impossible by construction.
- `Enabled = false` in production. The two-step opt-in (`Enabled` plus `AckExposesTokens`) is a backstop, not the strategy.

Full security model: [security.md](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/security.md).

## License

MIT.
