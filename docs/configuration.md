# Configuration Reference

Every option, its default, and why it exists.

## The full config shape

```ts
interface TokenInspectConfig {
  enabled: boolean;                            // default: false
  ackExposesTokens: boolean;                   // default: false
  capabilities: {
    clientObserver: boolean;                   // default: false
    storageScan: boolean;                      // default: false
    correlation: {
      enabled: boolean;                        // default: false
      header: string;                          // default: "traceparent"
      allowlist: string[];                     // default: ["self"]
    };
  };
  idp?: { issuer?: string };
  apis?: Array<{ match: string; lane: string }>;
  redaction: "didactic" | "mask";              // default: "didactic"
  mount: {
    dock: "bottom" | "right" | "left";         // default: "bottom"
    shadowDom: boolean;                        // default: true
  };
  egress?: { endpoint: string };
  preset?: "public-client-spa" | "bff-sessionmanager" | "api-validates-token";
  app?: string;
}
```

The default config is inert: `init({})` does nothing. Every capability is opt-in.

## Top-level options

### `enabled` (boolean, default `false`)

The master switch. With `enabled: false`, `init()` returns immediately. No DOM, no patching, no header. This is the safe default and the only correct value to leave compiled into production builds that should not surface the panel.

### `ackExposesTokens` (boolean, default `false`)

A second, explicit acknowledgement required to enable the plugin on a prod-like host. The plugin treats any host that is not `localhost`, `127.0.0.1`, `::1`, `*.local`, or one carrying `?ti-dev=1` as a potential production environment. Enabling without this flag on such a host is refused, with a console warning.

This exists so the configuration default of one environment cannot silently activate the panel in another. To turn it on in production-like environments you have to opt in twice: `enabled: true` and `ackExposesTokens: true`.

### `preset` (optional)

Applies a set of sane defaults for a known architecture, then lets your explicit config win. Available presets:

| Preset | Sets |
|---|---|
| `public-client-spa` | `capabilities.clientObserver: true`, `storageScan: true` |
| `bff-sessionmanager` | `capabilities.clientObserver: false` (the trace comes from the server via `egress.endpoint`) |
| `api-validates-token` | `capabilities.clientObserver: true`, `correlation: { enabled: true, allowlist: ["self"] }` |

Precedence is `defaults < preset < user config`. A preset can flip a default `false` to `true`, but your explicit `false` still wins.

### `app` (optional string)

A short label shown in the panel toolbar (for example, `"customer"`, `"web"`). Cosmetic; defaults to the preset name when present.

## Capabilities

### `capabilities.clientObserver` (boolean, default `false`)

Installs the browser observer: a pass-through wrap of `window.fetch` and `XMLHttpRequest`, a `Storage.setItem` watcher, and a redirect parser. The host call always runs first; instrumentation is in a `try`/`catch` that swallows on error.

Tradeoffs:

- See: every `fetch` / XHR, what tokens the browser holds, what claims are sent.
- Do not see: HttpOnly cookies, server internals, tokens that never reach the browser.
- Cost: tiny per-call overhead; no risk to host behaviour because wraps are pass-through and double-wrapped detection refuses to install if another wrapper is already in place.

Leave this `false` if your tokens live only on the server.

### `capabilities.storageScan` (boolean, default `false`)

A separate opt-in for actively scanning `localStorage` and `sessionStorage` for JWT-shaped values. Listed separately from `clientObserver` because "locating tokens by pattern" is a more sensitive capability than "observing the network calls the app already makes". You can have the observer on and the scan off.

### `capabilities.correlation`

Controls outgoing header injection that lets a server middleware merge its run with the client's run.

- `enabled` (boolean, default `false`): inject the header on outgoing requests that pass the allowlist.
- `header` (string, default `"traceparent"`): the name. W3C standard by default, neutral and safe. The plugin **refuses** any name that starts with `x-token-inspect` (case-insensitive): a header that identifies the tool is forbidden.
- `allowlist` (string[], default `["self"]`): which hosts receive the header. `"self"` is same-origin. Additional entries are explicit hostnames. Wildcards are not permitted. Cross-origin third-party hosts (analytics, payment, CDN) **never** receive the header, regardless of configuration.

## Architecture hints

### `idp` (optional)

```ts
idp: { issuer: 'https://idp.example.com/realms/main' }
```

A hint for the observer: traffic to this issuer is recognised as IdP traffic without discovery. Otherwise the observer matches `/.well-known/openid-configuration`, `/protocol/openid-connect/auth`, and `/protocol/openid-connect/token`.

### `apis` (optional)

```ts
apis: [
  { match: 'accounts.api.example.com', lane: 'Accounts API' },
  { match: 'orders.api.example.com', lane: 'Orders API' },
]
```

Friendly lane labels for API hosts. Without these, lanes are labelled by hostname.

### `egress` (optional)

```ts
egress: { endpoint: '/api/inspect' }
```

The URL the panel polls for server-recorded traces. The plugin captures this value at `init()` and **freezes** it: it cannot be repointed at runtime by mutating the config. There is exactly one channel through which trace data flows to the panel, and you decide it once.

If `egress.endpoint` is set and `clientObserver` is off, the panel uses an `HttpTraceSource` only. If both are present, the panel uses a `CompositeTraceSource` and merges runs by `correlationId`.

## Cosmetics

### `mount.dock` (`"bottom"` | `"right"` | `"left"`, default `"bottom"`)

The default dock position. Users can change it interactively from the toolbar.

### `mount.shadowDom` (boolean, default `true`)

Mount the panel inside a closed Shadow DOM with the panel's stylesheet inlined. Keeps the host page's CSS and the plugin's CSS isolated from each other. Turn it off only for debugging the panel itself.

### `redaction` (`"didactic"` | `"mask"`, default `"didactic"`)

`"didactic"` shows full values when you click Decode or Reveal. `"mask"` replaces sensitive values with a placeholder, even when revealed. Use `"mask"` if the panel is reachable by users who are not the principal of the session.

## Examples

### Minimum to turn anything on

```ts
init({
  enabled: true,
  ackExposesTokens: true,
});
```

This mounts the panel with an empty `LiveTraceSource`. You will see the floating button but no runs until you turn on a capability or set an egress.

### Pure browser observer

```ts
init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'public-client-spa',
  idp: { issuer: 'https://idp.example.com/realms/main' },
  apis: [{ match: 'api.example.com', lane: 'Main API' }],
});
```

### Server-recorded (BFF)

```ts
init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'bff-sessionmanager',
  egress: { endpoint: '/api/inspect' },
  app: 'web',
});
```

### Hybrid: client + server merged

```ts
init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'api-validates-token',
  egress: { endpoint: '/__ti/trace' },
  idp: { issuer: 'https://idp.example.com/realms/main' },
});
```

The observer reconstructs the browser side, the middleware records the server side, and the panel merges them by `correlationId`.

## On the server (ASP.NET options)

```csharp
public sealed class AspNetCoreOptions
{
    public bool Enabled { get; set; } = false;
    public bool AckExposesTokens { get; set; } = false;
    public string EndpointPath { get; set; } = "/__ti/trace";
    public bool LoopbackOnly { get; set; } = true;
    public string CorrelationHeader { get; set; } = "traceparent";
    public int RingCapacity { get; set; } = 256;
    public TimeSpan Ttl { get; set; } = TimeSpan.FromMinutes(15);
    public Func<HttpContext, string, bool> Authorize { get; set; } = (_, _) => false;
}
```

- `Authorize` defaults to deny. The host must provide a real check. Header-trust ACLs are impossible by construction.
- `LoopbackOnly` binds the dev endpoint to loopback interfaces by default.
- `EndpointPath` is configurable so the path itself is not a clue about what the endpoint exposes.
- `RingCapacity` and `Ttl` bound memory use.
