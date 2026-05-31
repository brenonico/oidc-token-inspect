# @token-inspect/browser

The drop-in path for the [Token Inspect](https://github.com/brenonico/oidc-token-inspect) plugin. One `init({...})` call mounts the panel inside a closed Shadow DOM. Inert by default; production hard-stop without explicit acknowledgement.

Use this if you want the panel in any web app without wiring React yourself. Works with React, Angular, Vue, vanilla, or legacy.

## Install (npm)

```bash
npm install @token-inspect/browser
```

```ts
import { init } from '@token-inspect/browser';

init({
  enabled: true,
  ackExposesTokens: true,
  preset: 'public-client-spa',   // or 'bff-sessionmanager' / 'api-validates-token'
});
```

## Drop-in script (no bundler)

The package ships a UMD bundle that mounts a global `window.TokenInspect`:

```html
<script src="https://your-cdn/token-inspect.umd.cjs"
        integrity="sha384-REPLACE_WITH_PUBLISHED_HASH"
        crossorigin="anonymous"></script>
<script>
  window.TokenInspect.init({
    enabled: true,
    ackExposesTokens: true,
    preset: 'public-client-spa',
  });
</script>
```

The bundle ships its own React and ReactDOM (no external React needed).

## Configuration

Every option, default and meaning is in [configuration.md](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/configuration.md).

Quick choices:

- `preset: 'public-client-spa'` for SPAs that hold tokens in `localStorage` and do PKCE in the browser.
- `preset: 'bff-sessionmanager'` plus `egress.endpoint` for cookie-session apps where the server records the trace.
- `preset: 'api-validates-token'` plus a server middleware for hybrid client + server merged by `correlationId`.

## Security

Read [security.md](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/security.md) before going to production. Highlights:

- Inert default; two-step opt-in required (`enabled: true` and `ackExposesTokens: true`).
- Production hard-stop refuses to enable on a prod-like host without acknowledgement.
- W3C `traceparent` correlation, same-origin allowlist only.
- Frozen egress at `init()`; not runtime-mutable.
- Clean teardown via `teardown()` plus a `selfTest()` that proves restoration.

## License

MIT.
