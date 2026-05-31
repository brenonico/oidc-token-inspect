# Token Inspect

A didactic token-flow inspector for any OIDC/OAuth2 application. Drops into the page as a script, an npm import, or an ASP.NET middleware, and shows the OAuth/OIDC flows that actually run, with full token claim decode and a DevTools-style timeline.

Architecture-agnostic by design. Works whether your tokens live in `localStorage` (public-client SPA), behind a BFF (cookie sessions), or only on the server (token validated by an API). You pick the adapter that matches where the token lives; the panel renders the same trace schema either way.

## Why it exists

Onboarding teams to OIDC and OAuth is hard. Every architecture has its own pitfalls (PKCE step, refresh rotation, audience leaks, RBAC vs scope confusion). Documentation alone rarely closes the gap.

Token Inspect lets a developer SEE the flow: the PKCE code verifier, the redirect to the IdP, the token endpoint exchange, the claims of the access token, the audience of an internal call, the refresh rotation. The panel is read-only and didactic; the goal is understanding.

## Three ways to consume

### 1. Drop-in script (any framework, including vanilla and legacy)

```html
<script src="https://cdn.example.com/token-inspect.umd.cjs"
        integrity="sha384-..." crossorigin="anonymous"></script>
<script>
  window.TokenInspect.init({
    enabled: true,
    ackExposesTokens: true,
    preset: 'public-client-spa',
  });
</script>
```

### 2. React/Vite project

```ts
import { init as initTokenInspect } from '@token-inspect/browser';

initTokenInspect({
  enabled: true,
  ackExposesTokens: true,
  preset: 'bff-sessionmanager',
  egress: { endpoint: '/api/inspect' },
  app: 'my-app',
});
```

### 3. Direct React component (own mounting)

```tsx
import { TokenInspectPanel, HttpTraceSource } from '@token-inspect/react';

const source = new HttpTraceSource(apiClient, '/api/inspect');
return <TokenInspectPanel source={source} app="my-app" />;
```

### 4. ASP.NET host (server-recorded path)

```csharp
builder.Services.AddTokenInspect(opts =>
{
  opts.Enabled = builder.Configuration.GetValue("TokenInspect:Enabled", false);
  opts.Authorize = (ctx, sid) => /* host-defined ownership check */;
});

// ...
app.MapTokenInspect();
```

Or the generic drop-in middleware that records server-side hops by trace-id:

```csharp
builder.Services.Configure<AspNetCoreOptions>(opts =>
{
  opts.Enabled = true;
  opts.AckExposesTokens = !builder.Environment.IsProduction();
  opts.Authorize = (ctx, id) => /* principal-derived */;
});

app.UseTokenInspect();
app.MapTokenInspectDev();   // /__ti/trace (dev endpoint, default loopback only)
```

## Architecture

Token Inspect captures the trace at the point where the token is observable. Three adapters fit three vantage points; you pick the one that matches your architecture.

| Adapter | What it sees | Best for |
|---|---|---|
| ClientObserver (`@token-inspect/browser`) | Browser flows: PKCE, fetch and XHR, storage writes, redirects, decoded claims | Public-client SPAs holding tokens in localStorage |
| ServerMiddleware (`TokenInspect.AspNetCore`) | Inbound token validation, RBAC decision, downstream calls, server-side stores | APIs where the token lives only on the server |
| ExplicitRecorder (`TokenInspect`) | Anything the host explicitly records via `IFlowRecorder.Record(...)` | BFF/SessionManager patterns with full server control |

All three emit the same trace schema. The panel reads from a pluggable `TraceSource` (`HttpTraceSource`, `LiveTraceSource`, or a `CompositeTraceSource` that merges client and server runs by `correlationId`).

## Security model

This is a didactic tool that, by design, displays values normally kept off the page. The mechanism is built to be safe-by-default:

- Inert by default. With empty config or `enabled:false`, `init()` does nothing: no DOM, no monkey-patching, no header.
- Production hard-stop. On a prod-like host, enabling requires an explicit `ackExposesTokens=true` second flag, plus a startup warning.
- No header trust. The ASP.NET endpoint never derives identity from a request header; the host provides a principal-derived `Authorize` delegate that defaults to deny.
- Anonymized correlation. Default header is the W3C `traceparent`; the plugin refuses outgoing header names that identify itself.
- Same-origin only. Correlation header is injected only on the configured allowlist (default: same-origin), never cross-origin.
- Clean removal. `teardown()` restores patched globals, removes listeners, unmounts the panel. A `selfTest()` proves the global state is intact.
- Frozen egress. The endpoint is captured at init and is not runtime-mutable.
- Supply chain. UMD builds emit SRI hashes; the script must be loaded with `integrity=` in production.

See [docs/spec.md](docs/spec.md) for the full security and isolation principle.

## Packages

| Package | Lang | Purpose |
|---|---|---|
| [`@token-inspect/core`](packages/core) | TypeScript | Schema (`FlowRun`, `TraceStep`, `TraceVariable`), `TraceSource` interface and built-in `Http`/`Live`/`Composite` implementations, `decodeJwt` |
| [`@token-inspect/react`](packages/react) | TypeScript + React | The slide-over DevTools panel, sequence diagram, variable cards, theme toggle |
| [`@token-inspect/browser`](packages/browser) | TypeScript | Drop-in `init()` plus UMD self-mount in Shadow DOM, ClientObserver (fetch/XHR wrap, PKCE reconstruction), `traceparent` correlation |
| [`TokenInspect`](dotnet/src/TokenInspect) | C# | `IFlowRecorder`, `ITraceStore` abstraction, `MapTokenInspect()` egress endpoint with `Authorize` delegate |
| [`TokenInspect.AspNetCore`](dotnet/src/TokenInspect.AspNetCore) | C# | Drop-in `UseTokenInspect()` middleware: token validation, RBAC, downstream calls; bounded ring + TTL; dev endpoint with loopback-only default and prod hard-stop |

## Development

```bash
# Install all JS workspaces
npm install

# Run all frontend tests (vitest)
npm test

# Build the UMD bundle
npm run build --workspace=@token-inspect/browser

# .NET build + test
cd dotnet
dotnet build TokenInspect.slnx
dotnet test TokenInspect.slnx
```

Node 22 (the engine declared by the packages). .NET 10.

## Documentation

- [docs/spec.md](docs/spec.md). Architecture-agnostic design (current target).
- [docs/spec-bff.md](docs/spec-bff.md). BFF/SessionManager vertical slice (origin spec).
- [docs/plan.md](docs/plan.md). Implementation plan, etapa by etapa.

## License

MIT. See [LICENSE](LICENSE).
