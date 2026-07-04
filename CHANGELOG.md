# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1](https://github.com/typicalday/owenloop/compare/v0.2.0...v0.2.1) (2026-07-04)


### Bug Fixes

* auto-skip submitted group siblings to prevent permanent wedge ([#15](https://github.com/typicalday/owenloop/issues/15)) ([484aea2](https://github.com/typicalday/owenloop/commit/484aea20d682196574b5c8c7da35bfd3e10619d3))
* catch child schema refusals as debts and version-pin the calls: mirror ([#16](https://github.com/typicalday/owenloop/issues/16)) ([500cce7](https://github.com/typicalday/owenloop/commit/500cce7152023391c19393ee5dcb18d802a6b2e8))
* close three commit-side verb guard gaps (F3, F5, F7) ([#11](https://github.com/typicalday/owenloop/issues/11)) ([fbcc777](https://github.com/typicalday/owenloop/commit/fbcc77700fefcf66f287e5e903ad7c03e9b59b64))
* refuse emit after the collection seal has greened (§11.1, F6) ([#17](https://github.com/typicalday/owenloop/issues/17)) ([cd963cf](https://github.com/typicalday/owenloop/commit/cd963cf9296504dc0278f9fa68d097a60e318c0f))
* ship src/ in the npm files allowlist ([#13](https://github.com/typicalday/owenloop/issues/13)) ([20ffcea](https://github.com/typicalday/owenloop/commit/20ffcea9132610203ef9da3cfa147990ad157ca9))

## [0.2.0](https://github.com/typicalday/owenloop/compare/v0.1.1...v0.2.0) (2026-07-04)


### Features

* per-produce override of maxAttempts / maxSchemaFailures ([#8](https://github.com/typicalday/owenloop/issues/8)) ([3285720](https://github.com/typicalday/owenloop/commit/32857203d0b587077733110f1231b272e39fed83))


### Bug Fixes

* eligibleFirings never offers a firing groupCasCheck will refuse ([#9](https://github.com/typicalday/owenloop/issues/9)) ([024b78f](https://github.com/typicalday/owenloop/commit/024b78f61094ba1fbce274ffa9d331a48fdc972f))

## [0.1.1](https://github.com/typicalday/owenloop/compare/v0.1.0...v0.1.1) (2026-07-04)


### Bug Fixes

* keep release-please tags as vX.Y.Z, not owenloop-vX.Y.Z ([#3](https://github.com/typicalday/owenloop/issues/3)) ([d5e9c37](https://github.com/typicalday/owenloop/commit/d5e9c37344f459a18a21f513a7898382a9ffac76))

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
