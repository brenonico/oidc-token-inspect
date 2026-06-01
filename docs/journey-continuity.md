# Journey continuity

A single OIDC journey is split across a redirect and, often, across more than one page load. The visitor starts anonymous on a landing page, is redirected to the identity provider, and returns authenticated to a different route. By default a trace tool sees three disconnected fragments. Journey continuity stitches them into one run, so the panel shows the pre-login lane and the post-login lane as a single story instead of starting in the middle.

## Why it matters

The didactic value of the panel is watching an anonymous session become an authenticated one: the visitor sees the `state` they sent, the redirect to the IdP, and the tokens that come back attributed to the same flow they started. Without continuity, the journal only begins recording after login, the anonymous part of the journey is lost, and the most instructive moment, the hand-off, is missing.

Two things break the single-run view, and v0.2.0 addresses each:

1. The browser reloads across navigations, so the in-memory journal is gone by the time the user returns.
2. The server has no way to know that the run it begins on `/callback` is the continuation of a run the SPA already started.

## The two pieces

### Client persistence (`PersistentTraceSource`)

`PersistentTraceSource` from `@oidc-token-inspect/core` mirrors the journal to Web Storage (`localStorage` by default) and restores it on construction, so the journal survives navigations within the same origin. The same backend holds the anonymous run id, so both the structure of the flow and the id that ties it together outlive a reload.

### Server correlation (`AdoptAnonymousRun`)

`IFlowRecorder.AdoptAnonymousRun` re-keys an in-flight anonymous run under the authenticated session id. When the SPA's anonymous id arrives on `/callback`, the server looks the run up, re-keys it via `ITraceStore.RekeyRunAsync`, and continues recording steps under the session id. The pre-login and post-login steps then belong to one `FlowRun`.

The bridge between the two pieces is the OAuth `state` parameter: the SPA carries its anonymous id out through `state` and the server reads it back on the callback.

## Configuration (browser)

Enable persistence and anonymous correlation in `init()`:

```ts
import { init } from '@oidc-token-inspect/browser';

const ti = init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'public-client-spa',
  persist: true,            // mirror the journal to localStorage so it survives navigations
  anonymousRunId: 'auto',   // generate or read a UUID v4 from storage
});

// Stamp the login URL with the anonymous run id (tii_anon=<id>), then carry that
// value through the OAuth state parameter when you build the authorize request.
const loginUrl = ti?.getLoginUrl('/oauth2/authorize?client_id=spa&response_type=code');
```

`anonymousRunId: 'auto'` generates a UUID v4 on first visit and persists it in the same storage backend, so the id is stable across reloads. `getLoginUrl(baseUrl)` appends `tii_anon=<id>` to the URL you advertise on your login button; the host is responsible for round-tripping that id through `state`.

## Adoption on the host (`/callback`)

Adopt the anonymous run in the callback handler, after you exchange the code and know the session id. `AdoptAnonymousRun` returns the resumed run, or `null` when no anonymous run exists for that id (it expired, was cleared, or this is a first-ever visit), leaving you to begin a fresh run.

```csharp
using TokenInspect;

app.MapGet("/callback", async (HttpContext context, IFlowRecorder recorder) =>
{
    // The anonymous run id was round-tripped through the OAuth state parameter.
    string anonymousRunId = ReadAnonymousRunId(context.Request.Query["state"]);
    string sessionId = await CompleteCodeExchangeAsync(context);

    FlowRun? run = await recorder.AdoptAnonymousRun(anonymousRunId, sessionId);
    run ??= recorder.BeginRun(
        flowKind: "auth.login",
        title: "Sign-in",
        participants: ["Browser", "API", "IdP"],
        correlationKey: sessionId);

    recorder.Step(run, "Session established", from: "API", to: "Browser",
        [TraceVariable.Plain("sub", sessionId)]);

    return Results.Redirect("/app");
});
```

The returned run is already re-keyed under `sessionId`, so every step you record after adoption persists under the session id and the journal the SPA fetches after login carries the pre-login steps too. To annotate the adoption (for example, with the pre-login landing page), pass a metadata dictionary as the third argument; it is merged into the run.

## Security trade-offs

- **Token redaction is the default.** The persisted snapshot strips JWT-shaped and `token`-kind variables, replacing them with `[redacted]`. The stored record is the flow structure, not the secrets. Persisting raw tokens is opt-in (`new PersistentTraceSource({ persistTokens: true })`) and is not recommended outside a throwaway dev box.
- **TTL bounds staleness.** Entries default to a 24 hour TTL, enforced on both read and write: an expired run is filtered out when the journal is restored and when it is read back. Set `ttlMinutes` to shorten it.
- **localStorage is same-origin.** The persisted journal and the anonymous id are readable only by pages on the same origin. They never travel cross-origin, and the plugin never transmits them off-origin.
- **Growth is capped.** A ring-buffer size cap (default 500 KB) evicts the oldest run when the snapshot would exceed it, so the journal cannot grow without bound.
- **The IdP stays out of scope.** The redirect to the identity provider is a visible gap in the sequence. The plugin does not instrument the IdP, so its internals (how it authenticated the user, what it stored, how it minted the token) are never observed. The diagram shows the hand-off and resumes when the browser returns.

See [docs/security.md](security.md) for the persistence-safety section in the context of the full threat model, and [docs/getting-started.md](getting-started.md) for the public-landing-page setup.
