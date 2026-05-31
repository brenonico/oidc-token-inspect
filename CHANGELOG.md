# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `TokenInspect.AspNetCore`: `InspectingHttpMessageHandler` and `AddInspectingHandler` to auto-record a request and response step for each outgoing `HttpClient` call when an ambient `InspectFlow` scope is active. Redacts credential headers by default, optionally previews request and response bodies, and is a pass-through outside any scope.
- Correlate anonymous runs to authenticated sessions via the OAuth `state` parameter. The browser plugin generates and persists an `anonymousRunId` (`init({ anonymousRunId: 'auto' })`) and exposes `getLoginUrl(baseUrl)` to append `tii_anon=<id>` to the login URL; on the server, `IFlowRecorder.AdoptAnonymousRun` re-keys the in-flight run under the new session id via `ITraceStore.RekeyRunAsync`.
- Docs: anonymous and pre-login context guidance in `docs/getting-started.md`.
- `TokenInspect`: `InspectFlow` ambient activity scope (`AsyncLocal`-based) for recording steps without threading `IFlowRecorder` through layers. Existing explicit API is unchanged.
- `TokenInspect.AspNetCore`: `WithInspectFlow` endpoint metadata and middleware. Endpoints declare a flow via `.WithInspectFlow(...)`; `UseInspectFlow()` opens an ambient `InspectFlow` scope around each request, completing on 2xx/3xx and failing on 4xx/5xx or exceptions.
- `PersistentTraceSource` in `@oidc-token-inspect/core`: a `TraceSource` backed by `localStorage` that restores the journal on construction so it survives navigations within the same origin. Tokens are redacted from the persisted snapshot by default (opt in with `persistTokens: true`); a TTL and a ring-buffer size cap bound staleness and growth.

## [0.1.0]

Initial public release.
