# Security Model

Token Inspect is a tool that, by design, shows on screen values that an application would normally keep off the page. That is the point: it teaches by making the flow visible.

This document is honest about what that means and what the plugin does to keep the **mechanism** safe even though the **content** is intentionally visible.

## The contract

The plugin is allowed to display tokens to the principal who owns them, in a development or didactic context, with two-step opt-in. It is **not** allowed to:

- Transmit observed values to any host other than the configured egress (which is host-controlled).
- Be enabled silently in production by a default carried over from another environment.
- Identify itself in outgoing requests where it would leak the fact of instrumentation.
- Survive an uninstall: removing the plugin restores the host to its original state.
- Block, alter, retry, or reorder the host's network traffic.

Each commitment maps to a control below.

## Threat model

We treat as adversaries:

1. An accidental deployment of the plugin to production with default config.
2. A misconfigured `Authorize` delegate that returns true too broadly.
3. An attacker already on the page (XSS) who tries to use the plugin as an exfiltration channel.
4. A compromised CDN or build artifact replacing the script.
5. A malicious or careless developer who wires the plugin into an audit-sensitive path.

We do not protect against:

- An attacker with full server access (they already have your tokens).
- A device-level compromise (the browser process can read its own memory).
- A developer who looks at the values on their own screen (that is the use case).

## Controls

### 1. Inert default

The whole plugin is no-op until two flags are set:

```ts
init({ enabled: true, ackExposesTokens: true })
```

With `enabled: false` (the default): no DOM, no panel, no monkey-patch, no listener, no header. `window.fetch === fetch`. The plugin is invisible.

`ackExposesTokens` is a second, separate acknowledgement. You cannot enable the plugin on a prod-like host with one config option alone. The intent has to be expressed twice, once per concern.

### 2. Production hard-stop

The plugin treats any host that is not `localhost`, `127.0.0.1`, `::1`, `*.local`, or carrying `?ti-dev=1` as a production candidate. On such a host, enabling without `ackExposesTokens` is **refused**, with a console warning.

Override `looksLikeProd` only if you understand why you are doing it. The default is conservative on purpose.

### 3. No header-trust ACL

The ASP.NET endpoint that exposes server-recorded traces (`MapTokenInspectDev`) does **not** read identity from a request header. It calls an `Authorize` delegate the host provides; the delegate is given the `HttpContext` and must decide. The delegate defaults to **deny**.

A common mistake in similar tools is to authorise on the basis of a session id that the caller themselves sets in a request header. That is an IDOR primitive. The plugin makes it impossible: there is no input the caller can set that grants access on its own.

### 4. Anonymised correlation header

The plugin uses the W3C `traceparent` header by default. It is neutral and standard; an interceptor cannot infer from the header alone that Token Inspect is present.

Any header name starting with `x-token-inspect` (case-insensitive) is **rejected** at config time. The plugin will not advertise its own presence on the wire.

### 5. Same-origin allowlist for correlation

The correlation header is injected only on requests whose URL passes the configured allowlist. Default allowlist is `["self"]` (same-origin only). Additional entries are explicit hostnames; wildcards are not permitted.

Third-party hosts (analytics, payments, CDNs) never receive the header, regardless of configuration. This avoids CORS preflight surprises (a custom header turns a simple request into a preflighted one) and avoids leaking the correlation id to vendors.

### 6. Frozen egress

`egress.endpoint` is captured by value at `init()` and stored in a private variable. Mutating the original config object after init has no effect on the plugin's egress target. There is exactly one place to which trace data can be fetched, and you decide it once. Repointing at runtime is not a feature; it is an attack.

### 7. Clean removal (`teardown()` and `selfTest()`)

`teardown()` restores `window.fetch`, `XMLHttpRequest.prototype.open`, `Storage.setItem`, removes window listeners the panel attached, undoes any `document.body` padding the dock set, clears in-memory buffers, and unmounts the React root.

`selfTest()` returns `{ fetchRestored, xhrRestored, noResidualListeners }` based on a comparison against the pristine references captured at module load. If `selfTest()` reports anything but `true`, file a bug.

The teardown is idempotent. Calling it without a prior `init()` is a no-op.

### 8. Pass-through interception

Wraps of `fetch` and `XHR` run the host's call first, with original `this`, original arguments, and original return identity preserved. Instrumentation lives in a `try`/`catch` around the recording side only. A bug in the recorder never propagates into the host's request.

The plugin refuses to install a wrap if it detects another wrap already in place. Better to record nothing than to fight another library's interceptor.

### 9. Supply chain (script tag mode)

The UMD bundle is built with a post-build step that emits a SHA-384 hash. The README and your deployment must serve the script with `integrity="sha384-..." crossorigin="anonymous"`. A compromised mirror cannot ship a different binary; the browser will refuse to execute it.

When publishing to npm or NuGet, sign your releases. Verify against the manifest.

### 10. Shadow DOM is cosmetic, not security

The panel mounts in a closed Shadow DOM with the panel's stylesheet inlined. This isolates the panel's CSS from the host page (and the host's CSS from the panel). It is **not** a JavaScript sandbox. An XSS on the page can read everything the plugin can, because both live in the same JavaScript realm.

If your page already has an XSS, the plugin's visibility does not change the threat. If your page does not have an XSS, the panel cannot be read by a script you did not invite.

## What the host must do

The plugin handles its end; the host has its share:

1. **Provide a real `Authorize` delegate.** Do not leave it returning true. The principle is "the panel is for the principal who owns the trace".
2. **Set `Enabled: false` in production builds.** The two-step opt-in is a backstop, not a strategy.
3. **Serve the UMD with SRI.** If you skip `integrity=`, you accept the risk of a CDN swap.
4. **Restrict the correlation allowlist.** Default is `["self"]`. Extend it only to hosts you operate.
5. **Mind the egress endpoint visibility.** If `MapTokenInspectDev` is reachable by anonymous users, even with `Authorize` denying, you are advertising the tool. Loopback-only by default; keep it that way unless you have a reason.
6. **Audit `redaction: "didactic"` use.** It is fine for owner-only didactic use. If the panel could be seen by other users (a back-office app, for example), set `redaction: "mask"`.

## How to remove the plugin

If you want the plugin out completely:

```ts
import { teardown } from '@oidc-token-inspect/browser';
teardown();
```

Then remove the `<script>` tag or the `init()` call from your build. Verify with `selfTest()` before redeploying.

On the server, remove `app.UseTokenInspect()` and `app.MapTokenInspectDev()` from `Program.cs`, then redeploy. The package itself can stay as a transitive dependency; with no middleware registered, it does nothing.

## Reporting a security issue

If you find a way to bypass any of the controls above, please open an issue with the label `security`, or contact the maintainer privately. Specifically of interest:

- Any path that lets `init()` succeed without `enabled: true` and `ackExposesTokens: true` on a prod-like host.
- Any path that lets the `Authorize` delegate be bypassed.
- Any path that injects the correlation header cross-origin or to a host not in the allowlist.
- Any path through which `teardown()` leaves residue (verified by `selfTest()` returning `false`).
- Any path that lets the plugin transmit observed values to a host other than the configured egress.
