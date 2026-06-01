# Instrumentation levels

Server-side tracing in `TokenInspect` has three levels. They all record into the same `FlowRun` schema and feed the same panel; they differ only in how much you wire by hand and how much the library does for you.

| Level | API | You control | The library handles |
|---|---|---|---|
| 1. Explicit | `IFlowRecorder` | Every begin, step, and complete | Nothing implicit |
| 2. Ambient | `InspectFlow.Begin` / `InspectFlow.Step` | Where the flow begins and ends | Carrying the run through nested calls |
| 3. Declarative | `.WithInspectFlow(...)` | Which endpoint is a flow | Begin and complete, from the request lifecycle |

All three require `AddTokenInspect()` at startup and a host-provided `ITraceStore`. Higher levels are built on the level below: `InspectFlow` resolves the same `IFlowRecorder`, and `WithInspectFlow` opens an `InspectFlow` scope.

## Level 1 - Explicit (`IFlowRecorder`)

The v0.1 API. You inject `IFlowRecorder`, begin a run, record each step, and complete it. Nothing is implicit: the run is a value you hold and pass.

Use this when you want full control and no magic: a BFF or session manager that records at precise points, or any code where you would rather see the run threaded explicitly than rely on ambient context.

```csharp
using TokenInspect;

public sealed class LoginService(IFlowRecorder recorder)
{
    public async Task SignInAsync(string username, string sessionId)
    {
        FlowRun run = recorder.BeginRun(
            flowKind: "auth.login",
            title: "Password sign-in",
            participants: ["Browser", "API", "IdP"]);

        recorder.Step(run, "Submit credentials", from: "Browser", to: "API",
            [TraceVariable.Plain("username", username)]);

        string accessToken = await ExchangeWithIdpAsync(username);

        recorder.Step(run, "Token issued", from: "IdP", to: "API",
            [TraceVariable.Jwt("access_token", accessToken)]);

        recorder.Complete(run, sessionId);
    }
}
```

`BeginRun` returns the `FlowRun` you pass to every `Step` and to `Complete`. If the flow can fail, call `recorder.Fail(run, reason)` instead of `Complete`. The recorder swallows storage errors internally, so instrumentation never breaks the host flow.

## Level 2 - Ambient (`InspectFlow.Begin`)

The ambient scope API. Open a scope once at the flow's entry point with a `using` block; any code reached from inside that block records steps with `InspectFlow.Step`, without an `IFlowRecorder` parameter and without the run being threaded through. The active scope flows with the logical async context (`AsyncLocal`), so concurrent flows stay isolated.

Use this for a long flow that spans many helpers, where threading `recorder` and `run` through every method signature would be noise.

Entry point:

```csharp
using TokenInspect;

public sealed class LoginService(CredentialVerifier verifier)
{
    public async Task SignInAsync(string username)
    {
        using InspectScope flow = InspectFlow.Begin(
            flowType: "auth.login",
            summary: "Password sign-in",
            actors: ["Browser", "API", "IdP"]);

        await verifier.VerifyAsync(username);
        // Disposing the scope auto-completes the run.
    }
}
```

A deep call site, with no recorder in scope and no run to pass:

```csharp
using TokenInspect;

public sealed class CredentialVerifier
{
    public async Task VerifyAsync(string username)
    {
        InspectFlow.Step("Verify credentials", from: "API", to: "IdP",
            [TraceVariable.Plain("username", username)]);

        // ... real verification ...
    }
}
```

`InspectFlow.Step` is a silent no-op when no scope is open, so instrumented helpers can call it unconditionally whether or not the current request is being traced. Disposing the scope completes the run unless you ended it explicitly with `flow.Complete(...)` or `flow.Fail(...)`.

## Level 3 - Declarative (`.WithInspectFlow(...)`)

The endpoint metadata API from `TokenInspect.AspNetCore`. When the whole flow boundary is a single endpoint, mark the endpoint with `.WithInspectFlow(...)` and add the middleware with `UseInspectFlow()`. The middleware opens an `InspectFlow` scope before the endpoint runs and completes it from the response status: 2xx/3xx completes, 4xx/5xx fails with `http_{status}`, and an unhandled exception fails with `exception:{TypeName}` and rethrows.

Use this when the flow is one request and you want the begin and complete handled for you. Inner code can still record intermediate hops with `InspectFlow.Step`.

```csharp
using TokenInspect;
using TokenInspect.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddTokenInspect(o => o.Enabled = true);
// The host also registers an ITraceStore implementation.

var app = builder.Build();
app.UseInspectFlow();

app.MapPost("/account/stepup", async (StepUpRequest request) =>
{
    InspectFlow.Step("Re-authenticate", from: "API", to: "IdP",
        [TraceVariable.Plain("acr", "mfa")]);

    StepUpResult result = await StepUpAsync(request);
    return Results.Ok(result);
})
.WithInspectFlow(
    name: "auth.stepup",
    summary: "Step-up authentication",
    actors: ["Browser", "API", "IdP"]);

app.Run();
```

By default the run's correlation id is read from the authenticated principal's `sid` claim. Pass a `correlationIdAccessor` to `WithInspectFlow` to derive it differently. Place `UseInspectFlow()` after `UseRouting()` and before the endpoints in a classic pipeline; in a minimal-API pipeline add it anywhere before the endpoint executes.

## How to choose

```
Is the entire flow a single ASP.NET endpoint?
  yes -> Level 3 (.WithInspectFlow). Use InspectFlow.Step for any inner hop.
  no  -> Does the flow span many helpers you would rather not thread a recorder through?
           yes -> Level 2 (InspectFlow.Begin + InspectFlow.Step).
           no  -> Do you want explicit, no-magic control over every begin/step/complete?
                    yes -> Level 1 (IFlowRecorder).
```

The levels compose: a Level 3 endpoint can contain Level 2 `InspectFlow.Step` calls, and Level 2 is the same `IFlowRecorder` underneath. Start at the highest level that fits the flow boundary and drop a level only where you need more control.
