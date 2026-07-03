# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

First public release.

### Added

- **Debt-driven dataflow engine.** Steps fire on what they owe their live inputs,
  not on a status flag; the graph re-derives eligibility from current artifact
  values and knows when it has settled. Pure model (`model.ts`) split from the
  imperative shell (`engine.ts`).
- **`node:sqlite` persistence** in WAL mode with commit-fingerprint compare-and-swap.
  No native dependencies — the store is a thin typed wrapper over the Node built-in.
- **CLI** (`npx owenloop`) — create, tick/run, status, and graph rendering
  (DOT / Mermaid) over a workflow database.
- **Programmatic API** — `createEngine`, `Engine`, `Store`, definition loading
  (`loadDefs`, `parseDef`, `buildDef`, `validateDef`, `lintDef`), graph/trace
  builders, and `modelCheck` for bounded reachability.
- **Engine-version contract (design §27).** A definition may declare the engine
  version it targets (`engine:` key, defaults to 1). A def requiring a newer
  engine than this release supports is rejected with an upgrade message, so
  future format changes fail loud rather than silent. The supported version is
  exported as `SUPPORTED_ENGINE_VERSION` for preflight checks.
- **Opaque `x:` extension key** at the definition and step level — a validated
  map whose contents the engine never interprets, reserved for downstream
  tooling. It round-trips verbatim.
- **JSON Schema validation** of artifact values via `@cfworker/json-schema`.

### Notes

- Requires **Node ≥ 22.13.0** (where `node:sqlite` is available unflagged).
- The package ships compiled JavaScript plus type declarations (`dist/`); it does
  not ship TypeScript source, because Node cannot type-strip files under
  `node_modules`.
- Licensed under **Apache-2.0**.

[0.1.0]: https://github.com/typicalday/owenloop/releases/tag/v0.1.0
