# @token-inspect/react

The React components for the [Token Inspect](https://github.com/brenonico/oidc-token-inspect) plugin: a DevTools-style slide-over panel with a sequence diagram, variable cards with JWT decode and a theme toggle.

Use this directly if you want to mount the panel yourself inside your React tree. For the easier path (drop-in self-mounting via Shadow DOM), use [`@token-inspect/browser`](https://www.npmjs.com/package/@token-inspect/browser).

## Install

```bash
npm install @token-inspect/react @token-inspect/core
```

## Basic use

```tsx
import { TokenInspectPanel } from '@token-inspect/react';
import { HttpTraceSource } from '@token-inspect/core';

const httpClient = {
  get: (path: string) =>
    fetch(path, { credentials: 'include' }).then((r) => r.json()),
};
const source = new HttpTraceSource(httpClient, '/api/inspect');

function App() {
  return (
    <>
      <YourApp />
      <TokenInspectPanel source={source} app="my-app" />
    </>
  );
}
```

The panel handles its own state (open/closed, dock position, theme). You only provide the `source` and an optional `app` label.

See the [main README](https://github.com/brenonico/oidc-token-inspect#readme) and [architecture docs](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/architecture.md) for the full picture.

## Peer dependencies

`react` and `react-dom` >= 18.

## License

MIT.
