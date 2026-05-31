# oidc-token-inspect

A didactic, drop-in inspector for OIDC and OAuth 2.0 token flows. Adds a DevTools-style panel to any web app that decodes tokens, draws the sequence between actors (Browser, IdP, API), and shows the variables exchanged at each step. Read-only. Safe-by-default.

Works in three shapes:

- **Drop-in script tag** for any framework (vanilla, React, Angular, Vue, legacy).
- **npm import** for modern JS / TS projects.
- **ASP.NET middleware** for server-recorded traces.

All three paths render the same panel and consume the same schema.

```ts
import { init } from '@oidc-token-inspect/browser';

init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'public-client-spa',     // or 'bff-sessionmanager' / 'api-validates-token'
});
```

That is the full integration. The plugin auto-mounts a panel in a closed Shadow DOM, observes the browser's OAuth/OIDC traffic, and gives you a `☰` toggle.

## Why

OIDC and OAuth are easier taught with examples than with prose. A new developer reading about PKCE understands faster when they can see the `code_verifier` in `sessionStorage`, the `code_challenge` in the redirect URL, and the `access_token` claims that come back. This plugin shows exactly that, without changing the host's behaviour.

## Five-minute install

- [docs/getting-started.md](docs/getting-started.md). Install + four scenarios (public SPA, BFF, ASP.NET, vanilla) with copy-paste examples.

## Reference

- [docs/architecture.md](docs/architecture.md). The three adapters, the trace schema, the `TraceSource` contract, how client and server lanes merge.
- [docs/configuration.md](docs/configuration.md). Every option, default, and meaning.
- [docs/security.md](docs/security.md). The threat model, the ten built-in defences, what the host must do, how to report an issue.

## Packages

| Package | Language | Purpose |
|---|---|---|
| [`@oidc-token-inspect/core`](packages/core) | TypeScript | Schema, `TraceSource` interface and built-in implementations, JWT decode |
| [`@oidc-token-inspect/react`](packages/react) | React | The panel itself, sequence diagram, variable cards |
| [`@oidc-token-inspect/browser`](packages/browser) | TypeScript | Drop-in `init()` plus UMD self-mount in Shadow DOM, client observer, correlation header |
| [`TokenInspect`](dotnet/src/TokenInspect) | C# | `IFlowRecorder`, `ITraceStore`, egress endpoint with host-provided `Authorize` |
| [`TokenInspect.AspNetCore`](dotnet/src/TokenInspect.AspNetCore) | C# | Drop-in middleware that records server-side hops; dev endpoint loopback-only by default |

## What it is not

- Not a debugger. The panel cannot replay, retry, or alter a request.
- Not a logger. Trace data lives in memory and is rendered only to the principal who owns it; nothing is transmitted off-origin.
- Not a production analytics tool. Default is inert, second flag required to enable on prod-like hosts.
- Not a substitute for proper auth. The panel teaches by showing values that good security keeps off the page. Use it where teaching is the goal.

## Development

```bash
# JavaScript workspaces
npm install
npm test
npm run build --workspace=@oidc-token-inspect/browser

# .NET solution
cd dotnet
dotnet build TokenInspect.slnx
dotnet test TokenInspect.slnx
```

Node 22+. .NET 10. Tests: 113 frontend (vitest) + 25 backend (xUnit). CI on every push and pull request.

## Contributing

Issues and pull requests welcome. Please read [docs/security.md](docs/security.md) before working on the observer, correlation, or egress paths.

## License

[MIT](LICENSE).
