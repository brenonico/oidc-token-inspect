# Migration: 0.1 to 0.2

**No breaking changes. All v0.1 APIs continue to work unchanged.**

v0.2.0 is purely additive. `IFlowRecorder`, `MapTokenInspect`, `LiveTraceSource`, `HttpTraceSource`, `init()`, and every other v0.1 surface keep the same signatures and the same behaviour. The new features are conveniences layered on top; you adopt them where they remove boilerplate and leave the rest as it is.

Each section below shows the v0.1 pattern and the v0.2 idiomatic pattern side by side for the same task.

## Ambient flow scope (`InspectFlow`)

Recording a step from a helper deep in the call stack.

**v0.1** - thread `IFlowRecorder` and the `FlowRun` through every layer:

```csharp
public sealed class LoginService(IFlowRecorder recorder)
{
    public async Task SignInAsync(string username, string sessionId)
    {
        FlowRun run = recorder.BeginRun("auth.login", "Password sign-in",
            ["Browser", "API", "IdP"]);
        await _verifier.VerifyAsync(recorder, run, username);  // recorder + run passed down
        recorder.Complete(run, sessionId);
    }
}

public sealed class CredentialVerifier
{
    public async Task VerifyAsync(IFlowRecorder recorder, FlowRun run, string username)
    {
        recorder.Step(run, "Verify credentials", "API", "IdP",
            [TraceVariable.Plain("username", username)]);
    }
}
```

**v0.2** - open a scope at the entry point; helpers record into the ambient context:

```csharp
public sealed class LoginService(CredentialVerifier verifier)
{
    public async Task SignInAsync(string username)
    {
        using var flow = InspectFlow.Begin("auth.login", "Password sign-in",
            actors: ["Browser", "API", "IdP"]);
        await verifier.VerifyAsync(username);   // nothing threaded through
    }
}

public sealed class CredentialVerifier
{
    public async Task VerifyAsync(string username)
    {
        InspectFlow.Step("Verify credentials", "API", "IdP",
            [TraceVariable.Plain("username", username)]);
    }
}
```

## Declarative endpoint flows (`WithInspectFlow`)

Tracing a whole endpoint as one flow.

**v0.1** - begin and complete by hand inside the handler:

```csharp
app.MapPost("/account/stepup", async (StepUpRequest req, IFlowRecorder recorder) =>
{
    FlowRun run = recorder.BeginRun("auth.stepup", "Step-up authentication",
        ["Browser", "API", "IdP"]);
    try
    {
        StepUpResult result = await StepUpAsync(req);
        recorder.Complete(run, result.SessionId);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        recorder.Fail(run, $"exception:{ex.GetType().Name}");
        throw;
    }
});
```

**v0.2** - declare the flow on the endpoint; the middleware begins and completes it from the response:

```csharp
app.UseInspectFlow();

app.MapPost("/account/stepup", async (StepUpRequest req) =>
{
    StepUpResult result = await StepUpAsync(req);
    return Results.Ok(result);
})
.WithInspectFlow("auth.stepup", "Step-up authentication",
    actors: ["Browser", "API", "IdP"]);
```

## Auto-instrumented outgoing HTTP (`AddInspectingHandler`)

Recording each call an `HttpClient` makes to an upstream.

**v0.1** - record a request and response step by hand around every call, with the recorder and run in scope:

```csharp
recorder.Step(run, $"GET {url}", "Host", "Upstream",
    [TraceVariable.Url("url", url)]);
HttpResponseMessage response = await client.GetAsync(url);
recorder.Step(run, $"Response {(int)response.StatusCode}", "Upstream", "Host",
    [TraceVariable.Plain("status", ((int)response.StatusCode).ToString())]);
```

**v0.2** - register the handler once; every call on that client records automatically when a scope is open:

```csharp
builder.Services.AddHttpClient("idp")
    .AddInspectingHandler(o =>
    {
        o.FromActor = "Host";
        o.ToActor = "IdP";
    });

// At the call site, no per-call instrumentation:
HttpResponseMessage response = await client.GetAsync(url);
```

The handler redacts credential headers (`Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`) by default and is a pure pass-through when no `InspectFlow` scope is active.

## Journal persistence (`PersistentTraceSource`)

Keeping the browser-observed journal across a navigation.

**v0.1** - not possible. `LiveTraceSource` holds the journal in memory, so it is lost on every reload and redirect.

**v0.2** - use a persistent source (or `persist: true` in the drop-in):

```ts
import { PersistentTraceSource } from '@oidc-token-inspect/core';

const source = new PersistentTraceSource({ ttlMinutes: 60 });
```

```ts
// Or, with the drop-in:
init({ enabled: true, ackExposesTokens: true, persist: true });
```

Tokens are stripped from the persisted snapshot by default; a TTL and a ring-buffer cap bound staleness and growth.

## Anonymous-to-authenticated correlation (`AdoptAnonymousRun`)

Stitching a pre-login run to the authenticated session.

**v0.1** - not possible. The anonymous run on the landing page and the authenticated run after `/callback` were separate, with no shared key to join them.

**v0.2** - the SPA carries an `anonymousRunId` through the OAuth `state`, and the server adopts it:

```ts
const ti = init({ enabled: true, ackExposesTokens: true,
  persist: true, anonymousRunId: 'auto' });
const loginUrl = ti?.getLoginUrl('/oauth2/authorize?client_id=spa&response_type=code');
```

```csharp
// On /callback, after the code exchange:
FlowRun? run = await recorder.AdoptAnonymousRun(anonymousRunId, sessionId);
run ??= recorder.BeginRun("auth.login", "Sign-in", ["Browser", "API", "IdP"],
    correlationKey: sessionId);
```

See [docs/journey-continuity.md](journey-continuity.md) for the full lifecycle.

## Should I migrate?

The new patterns are worth adopting when:

- A flow spans many helpers and threading `IFlowRecorder` through them is noise. Move to `InspectFlow` (ambient).
- A flow boundary is exactly one endpoint. Use `.WithInspectFlow(...)` and let the middleware own begin/complete.
- A client makes several upstream calls you want traced uniformly. Register `AddInspectingHandler` once instead of instrumenting each call.
- The journey crosses a redirect or reload and you want the panel to show it as one run. Adopt persistence plus anonymous correlation.

Sticking with the explicit v0.1 API is the better choice when:

- You want every begin, step, and complete visible at the call site, with no ambient or lifecycle-driven behaviour to reason about.
- You record at points that do not map to an endpoint or to outgoing HTTP (custom business events, a BFF's internal stages).
- Determinism matters more than brevity: explicit recording has no `AsyncLocal` context to get wrong and no middleware ordering to mind.

There is no deadline and no deprecation. Migrate a flow when the new pattern removes more than it adds, and leave the rest on the explicit API.
