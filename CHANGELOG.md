# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/typicalday/owenloop/compare/v0.2.1...v0.3.0) (2026-07-15)


### Features

* re-home `hashDefForHub` into the hub-facing module (`src/hub.ts`) so the engine core carries no hub/CLI coupling, and add a test-based core/hub boundary lint (`test/boundaries.test.ts`)
* deep tick drives calls: children; surface child stalls on parent status ([#20](https://github.com/typicalday/owenloop/issues/20)) ([b1cc889](https://github.com/typicalday/owenloop/commit/b1cc88935be32429b73d6b1dd123aafab0490cf3))
* owenloop add &lt;owner&gt;/&lt;repo&gt;[@ref] — install workflow defs from GitHub ([#23](https://github.com/typicalday/owenloop/issues/23)) ([a74ea1c](https://github.com/typicalday/owenloop/commit/a74ea1cc63f0563e3d6a78d7588251280d27e4cc))
* owenloop login/connect/push/logout — hub onboarding for the CLI ([#24](https://github.com/typicalday/owenloop/issues/24)) ([bedf856](https://github.com/typicalday/owenloop/commit/bedf856c7a5494ea6f16b3d6f39347790198c784))
* CLI adopts hub parity — whoami-verified auth, server-truth push diff ([#27](https://github.com/typicalday/owenloop/issues/27)) ([e882c70](https://github.com/typicalday/owenloop/commit/e882c7065dcbd91647fce4cd508748fd6700967b))


### Bug Fixes

* guard status child summary against unresolvable child def; test dueAt min-fold ([#22](https://github.com/typicalday/owenloop/issues/22)) ([cb7ccd2](https://github.com/typicalday/owenloop/commit/cb7ccd2404f7477ed38d596321ec032c2e3756b5))
* hub CLI hardening — portable push hash, boolean-flag parse, login timeout ([#25](https://github.com/typicalday/owenloop/issues/25)) ([c36e1b6](https://github.com/typicalday/owenloop/commit/c36e1b6d67a425c0af42b99b705e603f68aaad46))
* CLI nits from PR #25 review — NaN flag guard, timeout message, stale comment ([#26](https://github.com/typicalday/owenloop/issues/26)) ([e438dcb](https://github.com/typicalday/owenloop/commit/e438dcb7b9709dcd31338565172caebeede5e5d9))

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
