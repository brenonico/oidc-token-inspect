# Getting Started

This guide walks you through installing the plugin, picking the scenario that matches your architecture, and getting a working trace in your browser in under five minutes.

## Install

### From npm

```bash
npm install @oidc-token-inspect/browser
```

The package brings its own React/ReactDOM bundled for the standalone path, so it works in React apps and in non-React apps alike.

### As a drop-in script (any framework, including legacy)

After you build or download the UMD bundle, include it via a script tag with Subresource Integrity:

```html
<script src="https://your-cdn/oidc-token-inspect/token-inspect.umd.cjs"
        integrity="sha384-REPLACE_WITH_PUBLISHED_HASH"
        crossorigin="anonymous"></script>
```

The bundle exposes a global `window.TokenInspect` with `init(config)` and `teardown()`.

## Pick your scenario

Token Inspect captures the flow at the point where the token is observable in your architecture. Pick the closest match.

### Scenario A. Public-client SPA, tokens in browser storage

Your single-page app does PKCE in the browser, exchanges the code, and stores the tokens in `localStorage` or `sessionStorage`. The `ClientObserver` wraps `fetch` and `XMLHttpRequest`, reads tokens directly from storage, and reconstructs the login, refresh, and API-call flows.

```ts
import { init } from '@oidc-token-inspect/browser';

init({
  enabled: true,
  ackExposesTokens: true,        // didactic mode; see security.md before going to production
  preset: 'public-client-spa',
  idp: { issuer: 'https://idp.example.com/realms/main' },
});
```

Reload the app, sign in normally, and click the floating button bottom-right.

### Scenario B. BFF or cookie-session app, tokens on the server

Your tokens never reach the browser. The frontend talks to a Backend-for-Frontend that holds the session server-side. To inspect, expose a JSON endpoint on your BFF that returns the recorded trace (see [architecture.md](architecture.md) for the schema), and point the panel at it.

```ts
import { init } from '@oidc-token-inspect/browser';

init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'bff-sessionmanager',
  egress: { endpoint: '/api/inspect' },
  app: 'my-app',
});
```

The panel uses `HttpTraceSource` to poll the endpoint and renders the runs your backend recorded. On the server side, you can use the `TokenInspect` .NET package as a starting point.

### Scenario C. ASP.NET API that validates the token

Your token is observable on the server (validation, RBAC, downstream calls), not on the browser. The `TokenInspect.AspNetCore` middleware records server-side hops; the browser panel fetches them by correlation id.

```csharp
// Program.cs
builder.Services.Configure<AspNetCoreOptions>(opts =>
{
    opts.Enabled = !builder.Environment.IsProduction();
    opts.AckExposesTokens = !builder.Environment.IsProduction();
    opts.Authorize = (ctx, id) => ctx.User?.Identity?.IsAuthenticated == true;
    opts.LoopbackOnly = true;
});

app.UseTokenInspect();
app.MapTokenInspectDev();
```

In the SPA:

```ts
init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'api-validates-token',
  egress: { endpoint: '/__ti/trace' },
});
```

Outgoing API calls now carry a `traceparent` header (same-origin only); the middleware buffers each request and the panel merges the client and server lanes for one end-to-end run.

### Scenario D. Vanilla, jQuery, legacy or any non-React app

```html
<script src=".../token-inspect.umd.cjs"
        integrity="sha384-..." crossorigin="anonymous"></script>
<script>
  window.TokenInspect.init({
    enabled: true,
    ackExposesTokens: true,
    preset: 'public-client-spa',
  });
</script>
```

The plugin mounts in a closed Shadow DOM, so your CSS and JS are unaffected. To remove it cleanly:

```js
window.TokenInspect.teardown();
```

## What you'll see

A floating button appears in the bottom-right corner. Click it to open the dock.

| Element | What it shows |
|---|---|
| Flow list (left) | Every run captured, grouped by kind (`auth.login`, `auth.refresh`, `token.exchange`, `api.call`, ...) |
| Sequence diagram (center) | Participant lifelines (Browser, IdP, API, ...) with one message arrow per step of the selected run |
| Variable cards (right) | The values exchanged at the active step: code verifier, state, access token, decoded claims |
| Decode button | Shows the JWT header and payload for tokens of kind `Jwt` |
| Reveal button | Shows the raw value for tokens of kind `Opaque` |

The panel is read-only. It does not replay, alter, or block anything. The interception is pass-through, in `try`/`catch` that swallows on the recording side: a bug in the plugin can never break a request.

## Verify the plugin is inert when you turn it off

The safest invariant of the plugin is the inert default. Verify it once:

```ts
import { init, selfTest } from '@oidc-token-inspect/browser';

init({});  // empty config → enabled: false
console.log(window.fetch === fetch);  // true, fetch not patched
console.log(document.querySelector('[data-ti-root]'));  // null, no panel mounted

init({ enabled: true, ackExposesTokens: true, preset: 'public-client-spa' });
// ... use it ...
import { teardown } from '@oidc-token-inspect/browser';
teardown();
console.log(selfTest());  // { fetchRestored: true, xhrRestored: true, noResidualListeners: true }
```

If `selfTest()` reports anything but `true` everywhere, file a bug.

## Anonymous and pre-login contexts

Enabling the panel on a marketing or landing page, before any sign-in has happened, has real didactic value. The visitor can watch an anonymous session evolve into an authenticated one, with the pre-login lane and the post-login lane sitting side by side in the same journal. Without this, the journal only starts recording after login, so the anonymous part of the journey is lost and the story begins in the middle.

Minimal config for a public landing page:

```ts
import { init } from '@oidc-token-inspect/browser';

init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'public-client-spa',
  persist: true,                 // requires 0.2.0+ (PersistentTraceSource)
  anonymousRunId: 'auto',        // requires 0.2.0+ (anonymous-run correlation)
});
```

There are trade-offs to weigh. The persisted journal stays in same-origin `localStorage`, and tokens are not persisted by default, so the stored record is the flow structure rather than the secrets. The redirect to the identity provider is a visible gap in the sequence: the IdP is intentionally out of scope and the plugin does not instrument it, so the diagram shows the hand-off and then resumes when the browser comes back. Keep in mind that `localStorage` has size limits and shared-tab semantics; the persistence layer enforces a TTL and a ring-buffer cap so the journal cannot grow without bound.

For the deep dive on how anonymous runs are connected to authenticated sessions, see [`docs/journey-continuity.md`](journey-continuity.md).

## Next steps

- Architecture overview: [architecture.md](architecture.md)
- Configuration reference (every option, default, and meaning): [configuration.md](configuration.md)
- Security model (threats, defenses, host responsibilities): [security.md](security.md)
