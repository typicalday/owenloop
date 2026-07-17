# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1](https://github.com/typicalday/owenloop/compare/v0.3.0...v0.3.1) (2026-07-17)


### Bug Fixes

* **ci:** make pack manifest test robust to npm 12 pack --json schema ([#64](https://github.com/typicalday/owenloop/issues/64)) ([25f556d](https://github.com/typicalday/owenloop/commit/25f556df13260a487a182695b3bf38483faccb03))

## [0.3.0](https://github.com/typicalday/owenloop/compare/v0.2.1...v0.3.0) (2026-07-17)


### Features

* **add:** offline crash-recovery via add --recover ([#63](https://github.com/typicalday/owenloop/issues/63)) ([17b1842](https://github.com/typicalday/owenloop/commit/17b1842cd1e2c079ffe6e832c6cbef21e935c5d5))
* CLI adopts hub parity — whoami-verified auth, server-truth push diff ([#27](https://github.com/typicalday/owenloop/issues/27)) ([e882c70](https://github.com/typicalday/owenloop/commit/e882c7065dcbd91647fce4cd508748fd6700967b))
* deep tick drives calls: children; surface child stalls on parent status ([#20](https://github.com/typicalday/owenloop/issues/20)) ([b1cc889](https://github.com/typicalday/owenloop/commit/b1cc88935be32429b73d6b1dd123aafab0490cf3))
* **defs:** auto-discover add-installed workflow defs by default ([#62](https://github.com/typicalday/owenloop/issues/62)) ([cd2d62b](https://github.com/typicalday/owenloop/commit/cd2d62b7b6319c3d51241d2ad488996da394d0ff))
* **hub:** transport + OAuth origin policy, strict push responses (SEC-2/4, REL-9/10) ([#33](https://github.com/typicalday/owenloop/issues/33)) ([2f5e999](https://github.com/typicalday/owenloop/commit/2f5e999d0a7eed9260b42e813681f9fcd855f3f7))
* owenloop add &lt;owner&gt;/&lt;repo&gt;[[@ref](https://github.com/ref)] -- install workflow defs from GitHub ([#23](https://github.com/typicalday/owenloop/issues/23)) ([a74ea1c](https://github.com/typicalday/owenloop/commit/a74ea1cc63f0563e3d6a78d7588251280d27e4cc))
* owenloop login/connect/push/logout — hub onboarding for the CLI ([#24](https://github.com/typicalday/owenloop/issues/24)) ([bedf856](https://github.com/typicalday/owenloop/commit/bedf856c7a5494ea6f16b3d6f39347790198c784))
* persist issued order packet at claim; add 'owenloop order' read verb ([#30](https://github.com/typicalday/owenloop/issues/30)) ([f77de53](https://github.com/typicalday/owenloop/commit/f77de539db7626f6df9bb5ea7b2a13cc0976a76b))
* re-home hashDefForHub into hub module, add core/hub boundary lint (0.3.0) ([#29](https://github.com/typicalday/owenloop/issues/29)) ([61f50bc](https://github.com/typicalday/owenloop/commit/61f50bc22adae57a966e0edcd9b33d88931d5010))
* retain immutable artifact history ([#32](https://github.com/typicalday/owenloop/issues/32)) ([e0dc624](https://github.com/typicalday/owenloop/commit/e0dc624ec79435fc87b2ba82b9fd549687fd5bb7))
* validate in-memory def sets + hard deep-tick call-depth bound (REL-4) ([#35](https://github.com/typicalday/owenloop/issues/35)) ([ad3564b](https://github.com/typicalday/owenloop/commit/ad3564bdc446d6e228e5ef083464997b9ad668b9))
* worker-label claim filter and per-step max-lease clamp ([#31](https://github.com/typicalday/owenloop/issues/31)) ([0345044](https://github.com/typicalday/owenloop/commit/034504407fa8b2182b5ada02a3860f6f791d9888))


### Bug Fixes

* **add:** atomic, collision-free, validated installs (REL-1/REL-2/REL-3) ([#40](https://github.com/typicalday/owenloop/issues/40)) ([7904446](https://github.com/typicalday/owenloop/commit/7904446c0175bba61a55ead6d52b1a0c725c4e38))
* **add:** correct recovery guidance in the park double-fault error message ([#57](https://github.com/typicalday/owenloop/issues/57)) ([571824e](https://github.com/typicalday/owenloop/commit/571824ef3b53abcd38ae6994923cc290a9f56e8c))
* **add:** crash-recovery journal so an interrupted install rolls forward or back to a consistent state ([#56](https://github.com/typicalday/owenloop/issues/56)) ([79aa875](https://github.com/typicalday/owenloop/commit/79aa8752fc024a6641cee35e50bf2d32947913fd))
* **add:** make directory commit + lockfile write one recoverable operation ([#46](https://github.com/typicalday/owenloop/issues/46)) ([7c43fef](https://github.com/typicalday/owenloop/commit/7c43fef6dc698a65b5e4f533dd42cf91f42d84fa))
* **add:** park old-name dir inside the rollback envelope; stop cleanup masking rename error ([#48](https://github.com/typicalday/owenloop/issues/48)) ([74bea2b](https://github.com/typicalday/owenloop/commit/74bea2b0ff2136d627c0e69a16b64a8b85d20b48))
* atomic child creation and transactional, order-checked store open (REL-5) ([#37](https://github.com/typicalday/owenloop/issues/37)) ([59119d2](https://github.com/typicalday/owenloop/commit/59119d276080946690182b0971e2f281d5783fa4))
* **calls:** atomic fresh-snapshot child provision (C2 creation-side isolation) ([#59](https://github.com/typicalday/owenloop/issues/59)) ([e6e951c](https://github.com/typicalday/owenloop/commit/e6e951ca5dc51730c0bc16abceef24560e602edf))
* CLI nits from PR [#25](https://github.com/typicalday/owenloop/issues/25) review — NaN flag guard, timeout message, stale comment ([#26](https://github.com/typicalday/owenloop/issues/26)) ([e438dcb](https://github.com/typicalday/owenloop/commit/e438dcb7b9709dcd31338565172caebeede5e5d9))
* **cli:** reject unknown options before any side effect ([#60](https://github.com/typicalday/owenloop/issues/60)) ([73fea0c](https://github.com/typicalday/owenloop/commit/73fea0cd485f0965b517dd12cdbd1ef3a793b3b6))
* credential backend authority, hub/auth deadlines, atomic symlink-refusing writes (REL-6/REL-7/SEC-3) ([#39](https://github.com/typicalday/owenloop/issues/39)) ([f71853b](https://github.com/typicalday/owenloop/commit/f71853b0893415c8d578b847262180a5b8d861b1))
* **engine:** atomic snapshot-and-commit for maintainCalls machine-green (cross-connection stale publish) ([#52](https://github.com/typicalday/owenloop/issues/52)) ([a496620](https://github.com/typicalday/owenloop/commit/a496620f1d79ae673327922f30a5c52062c9f439))
* **engine:** guard deep-tick calls: descent against cross-connection races ([#61](https://github.com/typicalday/owenloop/issues/61)) ([6867beb](https://github.com/typicalday/owenloop/commit/6867beb606c8c9a521c920e898384d67bdf0386f))
* **engine:** make max-lease cap opt-in; distinguish reap reasons (REL-8) ([#38](https://github.com/typicalday/owenloop/issues/38)) ([074fb5e](https://github.com/typicalday/owenloop/commit/074fb5e6a58248d172320fdf38f22418a13fe6b4))
* guard status child summary against unresolvable child def; test dueAt min-fold ([#22](https://github.com/typicalday/owenloop/issues/22)) ([cb7ccd2](https://github.com/typicalday/owenloop/commit/cb7ccd2404f7477ed38d596321ec032c2e3756b5))
* hub CLI hardening — portable push hash, boolean-flag parse, login timeout ([#25](https://github.com/typicalday/owenloop/issues/25)) ([c36e1b6](https://github.com/typicalday/owenloop/commit/c36e1b6d67a425c0af42b99b705e603f68aaad46))
* **security:** contain bodyFile resolution and bound archive extraction in add (SEC-1) ([#34](https://github.com/typicalday/owenloop/issues/34)) ([6d8ccfa](https://github.com/typicalday/owenloop/commit/6d8ccfac2cc92164fe6f0548a038423d983e2ca9))
* **security:** enforce response-size caps during download with a bounded streaming reader ([#54](https://github.com/typicalday/owenloop/issues/54)) ([47f8096](https://github.com/typicalday/owenloop/commit/47f8096cec701204094009421cde48ae4f3694e6))
* **security:** fail closed on uncorroborated add.journal crash recovery ([#58](https://github.com/typicalday/owenloop/issues/58)) ([d9a1890](https://github.com/typicalday/owenloop/commit/d9a1890d1933d274cf1b77c6f5e7f4e38f921c2a))
* **security:** ownership-token install lock with liveness-aware stale reclamation ([#55](https://github.com/typicalday/owenloop/issues/55)) ([647d008](https://github.com/typicalday/owenloop/commit/647d00893ef6f023c6d4126ce96ef230ea97b15f))
* **security:** refuse a symlinked .owenloop and default defs dir in add (SEC-3) ([#53](https://github.com/typicalday/owenloop/issues/53)) ([5bc96b1](https://github.com/typicalday/owenloop/commit/5bc96b17cf6fec6b771fbfc955af7443852afa79))
* **security:** refuse a symlinked default state.db and its SQLite sidecars (SEC-3 file-level) ([#49](https://github.com/typicalday/owenloop/issues/49)) ([0a54a2f](https://github.com/typicalday/owenloop/commit/0a54a2fa4eb153f9de7d05a21cf5211fba3b76a0))
* **security:** refuse a symlinked project .owenloop on state writes (SEC-3) ([#47](https://github.com/typicalday/owenloop/issues/47)) ([033bdef](https://github.com/typicalday/owenloop/commit/033bdef7c54b331aae28b0b0c47e5f4c6662dc0d))
* **security:** refuse HTTP redirects on all hub/auth requests ([#50](https://github.com/typicalday/owenloop/issues/50)) ([70617bc](https://github.com/typicalday/owenloop/commit/70617bc4e188339c39a12b5d1bc7df4c1cfcaea1))
* **security:** validate and contain installed.json paths before any filesystem operation ([#51](https://github.com/typicalday/owenloop/issues/51)) ([4496aa5](https://github.com/typicalday/owenloop/commit/4496aa5ea8573f6cec3277ffbc26f4b45e4dfbf9))
* **store:** deterministic legacy-child lookup + structural artifact change-detection ([#45](https://github.com/typicalday/owenloop/issues/45)) ([2350793](https://github.com/typicalday/owenloop/commit/235079347fc6d7cccc9c12da214ebdaab6cc36ae))

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
