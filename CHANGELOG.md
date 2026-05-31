# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Docs: anonymous and pre-login context guidance in `docs/getting-started.md`.
- `TokenInspect`: `InspectFlow` ambient activity scope (`AsyncLocal`-based) for recording steps without threading `IFlowRecorder` through layers. Existing explicit API is unchanged.
- `PersistentTraceSource` in `@oidc-token-inspect/core`: a `TraceSource` backed by `localStorage` that restores the journal on construction so it survives navigations within the same origin. Tokens are redacted from the persisted snapshot by default (opt in with `persistTokens: true`); a TTL and a ring-buffer size cap bound staleness and growth.

## [0.1.0]

Initial public release.
