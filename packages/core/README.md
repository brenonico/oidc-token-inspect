# @token-inspect/core

Schema types, `TraceSource` interface and built-in `HttpTraceSource`, `LiveTraceSource`, `CompositeTraceSource` implementations for the [Token Inspect](https://github.com/brenonico/oidc-token-inspect) plugin. Also includes `decodeJwt` and `shortPreview`.

Use this directly if you are integrating the panel without the drop-in browser bundle, or if you are writing your own adapter.

## Install

```bash
npm install @token-inspect/core
```

## Basic use

```ts
import {
  HttpTraceSource,
  LiveTraceSource,
  CompositeTraceSource,
  decodeJwt,
  type TraceJournal,
} from '@token-inspect/core';

const httpClient = {
  get: <T = TraceJournal>(path: string): Promise<T> =>
    fetch(path, { credentials: 'include' }).then((r) => r.json() as Promise<T>),
};
const source = new HttpTraceSource(httpClient, '/api/inspect');

const journal = await source.getJournal();
console.log(journal.runs);
```

See the [main README](https://github.com/brenonico/oidc-token-inspect#readme) and [architecture docs](https://github.com/brenonico/oidc-token-inspect/blob/main/docs/architecture.md) for the full picture.

## License

MIT.
