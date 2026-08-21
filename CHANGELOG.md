# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.13](https://github.com/typicalday/owenloop/compare/v0.5.12...v0.5.13) (2026-08-21)


### Bug Fixes

* **eval:** score charter no-match safety and catalog discovery independently ([#267](https://github.com/typicalday/owenloop/issues/267)) ([6c2cfea](https://github.com/typicalday/owenloop/commit/6c2cfea1ffa75168864c9b1d3d7e14b980857cdd))

## [0.5.12](https://github.com/typicalday/owenloop/compare/v0.5.11...v0.5.12) (2026-08-21)


### Bug Fixes

* **engine:** count callsInputs wiring as a consumer in the dead-end lint ([#265](https://github.com/typicalday/owenloop/issues/265)) ([9d2df92](https://github.com/typicalday/owenloop/commit/9d2df92c5cd18418b5eaee170e2d7c9099521f18))

## [0.5.11](https://github.com/typicalday/owenloop/compare/v0.5.10...v0.5.11) (2026-08-21)


### Features

* **engine:** bind interface calls at instance start ([#263](https://github.com/typicalday/owenloop/issues/263)) ([84dde86](https://github.com/typicalday/owenloop/commit/84dde86be15d0d82a4a8a98137eb257f8a1868e7))

## [0.5.10](https://github.com/typicalday/owenloop/compare/v0.5.9...v0.5.10) (2026-08-21)


### Features

* add graduate skill for ephemeral plan promotion ([#254](https://github.com/typicalday/owenloop/issues/254)) ([3dd4e81](https://github.com/typicalday/owenloop/commit/3dd4e81c7e2a557fd3e61ab29ec71f154cff8590))
* add hub ephemeral workflow skill ([#230](https://github.com/typicalday/owenloop/issues/230)) ([64b069b](https://github.com/typicalday/owenloop/commit/64b069bc1868f121c302a1f4380446bdd9c683c9))
* add plan compiler skill ([#251](https://github.com/typicalday/owenloop/issues/251)) ([8a1fb9a](https://github.com/typicalday/owenloop/commit/8a1fb9ac5c658f25eac28647c5f8b7d8ea282575))
* add safe workflow bundle garbage collection ([#221](https://github.com/typicalday/owenloop/issues/221)) ([2c2ca81](https://github.com/typicalday/owenloop/commit/2c2ca8149fa07c8ca0b6ad647903d43e62af6f12))
* add x.discovery lint convention ([#218](https://github.com/typicalday/owenloop/issues/218)) ([06ee581](https://github.com/typicalday/owenloop/commit/06ee5810c0ca4bed4c8bb9e61bb367300d071d76))
* declare and check workflow interface claims ([#252](https://github.com/typicalday/owenloop/issues/252)) ([fae1d83](https://github.com/typicalday/owenloop/commit/fae1d83b527ea41581cb5c6edad98c77929dd79e))
* **engine:** map authored capabilities to org names before composition ([#213](https://github.com/typicalday/owenloop/issues/213)) ([775813e](https://github.com/typicalday/owenloop/commit/775813e6a8caa874f48dd78beb2311d26bd0239a))
* expose pending gates to MCP and CLI clients ([#223](https://github.com/typicalday/owenloop/issues/223)) ([38ba485](https://github.com/typicalday/owenloop/commit/38ba4851ba29f1afcb0b02064a47725d63ae1eea))
* expose search_workflows over MCP ([#231](https://github.com/typicalday/owenloop/issues/231)) ([7223021](https://github.com/typicalday/owenloop/commit/7223021746cc2e7702319d5e3206972556ae5555))
* expose workflow discovery metadata in defs ([#222](https://github.com/typicalday/owenloop/issues/222)) ([ad8ca3b](https://github.com/typicalday/owenloop/commit/ad8ca3b15cfd2d21a2233a2d2bf4dcb4bae3e786))
* install outside defs under scoped capabilities ([#214](https://github.com/typicalday/owenloop/issues/214)) ([ae375cd](https://github.com/typicalday/owenloop/commit/ae375cd2d442336ddd254bff5899fc50216a55dc))
* **mcp:** add chief-of-staff charter ([#219](https://github.com/typicalday/owenloop/issues/219)) ([cc3f02f](https://github.com/typicalday/owenloop/commit/cc3f02f6747ed08cc0a36d9dcd32d503574d2f15))
* support oneOf, anyOf, and uniqueItems in interface compatibility ([#256](https://github.com/typicalday/owenloop/issues/256)) ([fb6710b](https://github.com/typicalday/owenloop/commit/fb6710bc2f65e0ca8078716247a3c58d48386d8b))


### Bug Fixes

* a claim released for capacity re-arms the next sweep ([#217](https://github.com/typicalday/owenloop/issues/217)) ([f09e93b](https://github.com/typicalday/owenloop/commit/f09e93b57eab64bbbc93fa4e9be4714fede86552))
* a returned lease is not a run for budget or cadence ([#215](https://github.com/typicalday/owenloop/issues/215)) ([e79fcc5](https://github.com/typicalday/owenloop/commit/e79fcc5ca325ce62a18f0558125dc0cf8edf5083))
* calls joins wait for whole-child completion ([#239](https://github.com/typicalday/owenloop/issues/239)) ([934215d](https://github.com/typicalday/owenloop/commit/934215d69381bb1fc189be1c424fb73d09070b3d))
* classify future idle waits as stalls, not deadlocks ([#250](https://github.com/typicalday/owenloop/issues/250)) ([1efec61](https://github.com/typicalday/owenloop/commit/1efec617ca27d24e8ceaab45c879f8677480e3cd))
* **cli:** report auth rate limits accurately ([#228](https://github.com/typicalday/owenloop/issues/228)) ([44da220](https://github.com/typicalday/owenloop/commit/44da2202b026deb49b69a2cc17bba5812180f12e))
* **cli:** route reject and provide to hub ([#220](https://github.com/typicalday/owenloop/issues/220)) ([1697b8d](https://github.com/typicalday/owenloop/commit/1697b8d17ea549516fb0f326de55aab94966d594))
* damp repeated capacity reclaims in Shift ([#243](https://github.com/typicalday/owenloop/issues/243)) ([c20003a](https://github.com/typicalday/owenloop/commit/c20003a179c71763043961d1c583da3cbe0865a0))
* drain CLI output before exit ([#235](https://github.com/typicalday/owenloop/issues/235)) ([eecf853](https://github.com/typicalday/owenloop/commit/eecf85327b631eca5512bc87d522db060b603ba7))
* **engine:** re-stamp owed version target when a reject re-arms a claim ([#211](https://github.com/typicalday/owenloop/issues/211)) ([ccf956c](https://github.com/typicalday/owenloop/commit/ccf956c02ed2cdec2659861724c3a235be99a6b8))
* keep a source schema's own constraints when checking its union branches ([#260](https://github.com/typicalday/owenloop/issues/260)) ([4803906](https://github.com/typicalday/owenloop/commit/4803906d7f41b61b8f617b3a40da3e6f6d6227e4))
* **mcp:** expose hub passthrough fields ([#227](https://github.com/typicalday/owenloop/issues/227)) ([32548f1](https://github.com/typicalday/owenloop/commit/32548f1cf2747f6599fd1e00a2cc859a8da64b53))
* **mcp:** put the catalog rule first in the chief-of-staff charter ([#233](https://github.com/typicalday/owenloop/issues/233)) ([e5ff766](https://github.com/typicalday/owenloop/commit/e5ff76656041bfe4c66785e5d1ce0d573114a020))
* model all collection member retractions ([#234](https://github.com/typicalday/owenloop/issues/234)) ([9b87542](https://github.com/typicalday/owenloop/commit/9b875423dd56f4153c386b75e3eda0861933ab15))
* read the capability mappings the hub actually returns ([#216](https://github.com/typicalday/owenloop/issues/216)) ([f416396](https://github.com/typicalday/owenloop/commit/f416396039baefeb6ca86a1c063ae53b28a6c2fa))
* report collection search cap usage ([#245](https://github.com/typicalday/owenloop/issues/245)) ([de4925c](https://github.com/typicalday/owenloop/commit/de4925cd0c72c8a4193bd3c8eee2a4507ba9f6f4))
* retry rate-limited exec receipt submissions ([#225](https://github.com/typicalday/owenloop/issues/225)) ([c5ce4bb](https://github.com/typicalday/owenloop/commit/c5ce4bb505c83ea420b3549f928ea51891d76eac))
* revive exclusive-group siblings when the winner is un-greened ([#253](https://github.com/typicalday/owenloop/issues/253)) ([66eab0a](https://github.com/typicalday/owenloop/commit/66eab0ad2805f09d0196673d968a54203a637222))
* settle a calls output when its gate input is skipped ([#257](https://github.com/typicalday/owenloop/issues/257)) ([c773a4e](https://github.com/typicalday/owenloop/commit/c773a4ef8cd6b012b007d8134a80ca282ba9bf9e))
* validate calls edges in lint and check ([#240](https://github.com/typicalday/owenloop/issues/240)) ([5741261](https://github.com/typicalday/owenloop/commit/5741261c19c7f694c2f25a919abd2acf2af13038))
* validate hub workflow IDs locally ([#244](https://github.com/typicalday/owenloop/issues/244)) ([da5e91f](https://github.com/typicalday/owenloop/commit/da5e91f8072f500d26f752aa4060beea70b6b0fb))
* **work:** surface and resolve command-step orders whose bundle is missing from the store ([#261](https://github.com/typicalday/owenloop/issues/261)) ([9dbd4f0](https://github.com/typicalday/owenloop/commit/9dbd4f03b1411b18c4f38e36a7da00cd1fc38b90))

## [0.5.9](https://github.com/typicalday/owenloop/compare/v0.5.8...v0.5.9) (2026-08-19)


### Features

* add --scope and --priority to owenloop start, default MCP scope to repo name ([#205](https://github.com/typicalday/owenloop/issues/205)) ([1270885](https://github.com/typicalday/owenloop/commit/12708856d837b6bba40c8294ad62d76940b3944a))
* add hub retry artifact controls ([#191](https://github.com/typicalday/owenloop/issues/191)) ([2afcaf6](https://github.com/typicalday/owenloop/commit/2afcaf6321ab952be7c7895e4e85907efd4965e5))
* bind artifact values to run modifier and meta, with deterministic init ([#200](https://github.com/typicalday/owenloop/issues/200)) ([ca7c402](https://github.com/typicalday/owenloop/commit/ca7c4026ff60816987dca43dfca492610dc43b09))
* declare cleanup steps for cancelled runs ([#204](https://github.com/typicalday/owenloop/issues/204)) ([bc3d1ef](https://github.com/typicalday/owenloop/commit/bc3d1ef94ca177cafa37c697709c26bef6d3a59d))
* **shift:** advertise serving capabilities ([#194](https://github.com/typicalday/owenloop/issues/194)) ([4ff4010](https://github.com/typicalday/owenloop/commit/4ff4010c57ba91c4b12cab812d0cbd2cc4b33b75))
* stamp matched crews on orders and resolve worker rosters from the stamp ([#193](https://github.com/typicalday/owenloop/issues/193)) ([aceae05](https://github.com/typicalday/owenloop/commit/aceae055d72eb54a0da8b5edb87b4ce3caddebe5))
* sync hub org rosters into the shift cache and merge them as the weakest layers ([#190](https://github.com/typicalday/owenloop/issues/190)) ([643e2fd](https://github.com/typicalday/owenloop/commit/643e2fdfe93c4b6d9dd80cd15a211c275b130918))


### Bug Fixes

* carry the child command output tail into a payload reject ([#197](https://github.com/typicalday/owenloop/issues/197)) ([e3ee61f](https://github.com/typicalday/owenloop/commit/e3ee61fbc51598d883a310e33b84abafb399aa98))
* do not hold hub claims a shift cannot dispatch ([#209](https://github.com/typicalday/owenloop/issues/209)) ([5b61433](https://github.com/typicalday/owenloop/commit/5b61433cab384107f5cf126253e0fd1b3c62e0c2))
* escalate failed command diagnostics through ask ([#203](https://github.com/typicalday/owenloop/issues/203)) ([583d4c3](https://github.com/typicalday/owenloop/commit/583d4c34772d32035b7067abc71620bf46143acc))
* log claude adapter turn activity ([#188](https://github.com/typicalday/owenloop/issues/188)) ([c9ba76a](https://github.com/typicalday/owenloop/commit/c9ba76a8948dd5dc0733a204313374322f2fa22f))
* make the bind shorthand resolve a key path instead of the whole value ([#206](https://github.com/typicalday/owenloop/issues/206)) ([03ac38c](https://github.com/typicalday/owenloop/commit/03ac38ca2066cf6e23592f693e484601efdd6ebb))
* make the modifier vocabulary consistent across parse, start, and bind ([#210](https://github.com/typicalday/owenloop/issues/210)) ([afd33a6](https://github.com/typicalday/owenloop/commit/afd33a6d5f49525e3e7e65a8df481af6b53c1a55))
* reserve dispatch capacity for exec orders ([#207](https://github.com/typicalday/owenloop/issues/207)) ([91c6a66](https://github.com/typicalday/owenloop/commit/91c6a66869b5b2c06c9db228818c6bb19c7ede9e))
* **shift:** release exited workers and resweep braked steps ([#196](https://github.com/typicalday/owenloop/issues/196)) ([1b23815](https://github.com/typicalday/owenloop/commit/1b238153caf5d4dacdce7731c06b64830dbe15ce))

## [0.5.8](https://github.com/typicalday/owenloop/compare/v0.5.7...v0.5.8) (2026-08-17)


### Features

* add layered crew roster routing ([#186](https://github.com/typicalday/owenloop/issues/186)) ([9fc1a55](https://github.com/typicalday/owenloop/commit/9fc1a55447bc48806d5b8775a9bdd5340f9258b8))
* add owenloop routing command group for alerts and reroute rules ([#182](https://github.com/typicalday/owenloop/issues/182)) ([012a16a](https://github.com/typicalday/owenloop/commit/012a16a97f01b2c98691403a2a8a9eba201ef889))
* let the offer caller reroute a composed capability ([#181](https://github.com/typicalday/owenloop/issues/181)) ([7240e61](https://github.com/typicalday/owenloop/commit/7240e61ee4263290d9eb1adfea96c3659a657ca9))


### Bug Fixes

* key session resume on the engine task, not on the per-firing run id ([#177](https://github.com/typicalday/owenloop/issues/177)) ([f1d4fbb](https://github.com/typicalday/owenloop/commit/f1d4fbbccab3048558a5319293e87bb3bcff22e8))
* relay a command step's output to the worker log on success too ([#185](https://github.com/typicalday/owenloop/issues/185)) ([618a3e0](https://github.com/typicalday/owenloop/commit/618a3e0309d79bb680f521c19fc183934f6f7bf8))
* surface a hub instance's terminal status in `instance show` ([#187](https://github.com/typicalday/owenloop/issues/187)) ([42e53bd](https://github.com/typicalday/owenloop/commit/42e53bd809bfe8e93a27ffa2941b8a89b0161bcc))

## [0.5.7](https://github.com/typicalday/owenloop/compare/v0.5.6...v0.5.7) (2026-08-16)


### Features

* bridge an escalated tool call to a human approval and back ([#174](https://github.com/typicalday/owenloop/issues/174)) ([aa60594](https://github.com/typicalday/owenloop/commit/aa6059445dc95fcd3f0a810ecfbdada2f687aa9c))
* let a codex step's escalated call reach the same human approval gate ([#175](https://github.com/typicalday/owenloop/issues/175)) ([e43ca74](https://github.com/typicalday/owenloop/commit/e43ca74bf51485a499cf6f254c6a7a34fd4a1a5d))
* tell a step agent the shape it owes, before it produces one ([#172](https://github.com/typicalday/owenloop/issues/172)) ([54461b4](https://github.com/typicalday/owenloop/commit/54461b490f5617931cd1751db08885873ec9cbe7))


### Bug Fixes

* stop one shift from killing another shift's live agent sessions ([#176](https://github.com/typicalday/owenloop/issues/176)) ([82d9d82](https://github.com/typicalday/owenloop/commit/82d9d82f84121749c32e7a67b36b9506a51020b2))

## [0.5.6](https://github.com/typicalday/owenloop/compare/v0.5.5...v0.5.6) (2026-08-15)


### Features

* gate tool calls so ask actually asks and auto-safe actually classifies ([#171](https://github.com/typicalday/owenloop/issues/171)) ([f1e95f5](https://github.com/typicalday/owenloop/commit/f1e95f5990f73399c5542cf2d103e16761792a64))
* tell every step agent where its inputs are and how much rope is left ([#169](https://github.com/typicalday/owenloop/issues/169)) ([47d0485](https://github.com/typicalday/owenloop/commit/47d0485f44ac893c9d2870f7afe31b8a4c42ca92))

## [0.5.5](https://github.com/typicalday/owenloop/compare/v0.5.4...v0.5.5) (2026-08-15)


### Features

* give every step agent a channel to ask a human ([#168](https://github.com/typicalday/owenloop/issues/168)) ([fa9e5f0](https://github.com/typicalday/owenloop/commit/fa9e5f08d3a9f55c6e95cc504966a6389ec699c4))
* let a shift operator declare where work may happen ([#166](https://github.com/typicalday/owenloop/issues/166)) ([71e9412](https://github.com/typicalday/owenloop/commit/71e9412c534ba826490dc62464989b47a6f551fe))

## [0.5.4](https://github.com/typicalday/owenloop/compare/v0.5.3...v0.5.4) (2026-08-15)


### Features

* add `owenloop cancel` to stop a running hub instance ([#158](https://github.com/typicalday/owenloop/issues/158)) ([76ccc75](https://github.com/typicalday/owenloop/commit/76ccc75cf4b1c9312484e691663f9e5c9e1ebe9a))
* add `owenloop instance show` to read a hub run's live state ([#161](https://github.com/typicalday/owenloop/issues/161)) ([9ab7cec](https://github.com/typicalday/owenloop/commit/9ab7cec6f72dc79c11c2c7079174f9581ff97304))
* let workdirFrom name a declared input, not only a consume ([#165](https://github.com/typicalday/owenloop/issues/165)) ([fff886b](https://github.com/typicalday/owenloop/commit/fff886b86c097a1b85de745faa322cf92d0e5615))
* state the submit contract in every rendered brief ([#160](https://github.com/typicalday/owenloop/issues/160)) ([f62430d](https://github.com/typicalday/owenloop/commit/f62430d1febc77597cafb25e8b2928f1ab7e7fb3))


### Bug Fixes

* deliver a payload reject before the owed submits, not after ([#164](https://github.com/typicalday/owenloop/issues/164)) ([b38b709](https://github.com/typicalday/owenloop/commit/b38b709aededd0ebef2684f8c64abb8fe68226de))
* relay a failed command step's own output to the exec log ([#162](https://github.com/typicalday/owenloop/issues/162)) ([d40595d](https://github.com/typicalday/owenloop/commit/d40595dbfe40bfbf6f5d729296189e5b88424eec))
* scope owenloop's config dir without hijacking XDG_CONFIG_HOME ([#163](https://github.com/typicalday/owenloop/issues/163)) ([72838b4](https://github.com/typicalday/owenloop/commit/72838b45e3fb6f52038001148bca62f879a90efc))

## [0.5.3](https://github.com/typicalday/owenloop/compare/v0.5.2...v0.5.3) (2026-08-14)


### Features

* let owenloop start pick a run modifier ([#154](https://github.com/typicalday/owenloop/issues/154)) ([a412b5b](https://github.com/typicalday/owenloop/commit/a412b5b334b5fd228d4558b50125e069512bd860))
* neutral permissionMode vocabulary across harness adapters ([#156](https://github.com/typicalday/owenloop/issues/156)) ([c96340f](https://github.com/typicalday/owenloop/commit/c96340f2d3f910e49838c6fbd68ed817e52f7ddc))

## [0.5.2](https://github.com/typicalday/owenloop/compare/v0.5.1...v0.5.2) (2026-08-14)


### Features

* durable on-disk shift logs (shift.log + per-run worker logs) ([#150](https://github.com/typicalday/owenloop/issues/150)) ([ad95862](https://github.com/typicalday/owenloop/commit/ad9586292b2d977f3c0be3f2f005c537eba03bfc))
* pass consumed inputs to command steps and warn on cwd fallback ([#149](https://github.com/typicalday/owenloop/issues/149)) ([76f0783](https://github.com/typicalday/owenloop/commit/76f0783201eb93b8af8ece4c8910952bec781b61))
* per-crew tier profiles with model and effort resolution ([#140](https://github.com/typicalday/owenloop/issues/140)) ([98d96bb](https://github.com/typicalday/owenloop/commit/98d96bbeaf3e17e0aa097389b766248f78e87451))
* route agent orders by composed capability instead of model tiers ([#152](https://github.com/typicalday/owenloop/issues/152)) ([a48068b](https://github.com/typicalday/owenloop/commit/a48068b547e16d1db763e3bc739c8277ae1fb628))
* routing modifiers, capability composition, and escalation in the engine ([#151](https://github.com/typicalday/owenloop/issues/151)) ([6d440a9](https://github.com/typicalday/owenloop/commit/6d440a951bc15bd961e4004c4652f6e87c88560c))


### Bug Fixes

* brake a shift step on worker failure, not on dispatch count ([#146](https://github.com/typicalday/owenloop/issues/146)) ([2b4c0c6](https://github.com/typicalday/owenloop/commit/2b4c0c657173c114377daa432b878a8dd12d0c05))
* distinguish a corrupt session record from a schema-invalid one ([#145](https://github.com/typicalday/owenloop/issues/145)) ([c65416b](https://github.com/typicalday/owenloop/commit/c65416b523efa5784a2e8f173ac44bd6b77435b0))
* issue a retry-safe owed target version so producer submits can sign ([#143](https://github.com/typicalday/owenloop/issues/143)) ([1a27f65](https://github.com/typicalday/owenloop/commit/1a27f65eb2abdba50f52931fd08c99ae3b3d2df6))
* measure escalation.after against the highest per-produce maxAttempts ([#153](https://github.com/typicalday/owenloop/issues/153)) ([0d654f9](https://github.com/typicalday/owenloop/commit/0d654f9e593ecdbc10a50cad8f59a5a73036016f))
* normalize a JSON-string submit value before signing it ([#147](https://github.com/typicalday/owenloop/issues/147)) ([2f67b12](https://github.com/typicalday/owenloop/commit/2f67b12453631ca9425ea66050eeb9afbbd32817))
* read the capability payloads under the hub's own field names ([#142](https://github.com/typicalday/owenloop/issues/142)) ([eb53609](https://github.com/typicalday/owenloop/commit/eb536093f4202afdd491269e7aab07bb60e21a1f))
* stop the agent-run MCP hold child from releasing its parent's claim ([#144](https://github.com/typicalday/owenloop/issues/144)) ([4b46fa8](https://github.com/typicalday/owenloop/commit/4b46fa84c15074924a937ff0954ee967bf4a1523))

## [0.5.1](https://github.com/typicalday/owenloop/compare/v0.5.0...v0.5.1) (2026-08-12)


### Features

* add bundle runtime compatibility requirements ([#137](https://github.com/typicalday/owenloop/issues/137)) ([6a241a3](https://github.com/typicalday/owenloop/commit/6a241a34f516da820e1dda5fd6953c28993ea1f5))
* add CLI/plugin compatibility checks ([#109](https://github.com/typicalday/owenloop/issues/109)) ([8f0b0b9](https://github.com/typicalday/owenloop/commit/8f0b0b9c2f8179ac316772fcbf61d5efe4fa9019))
* add command payload and judge reject transport ([#126](https://github.com/typicalday/owenloop/issues/126)) ([847a1fa](https://github.com/typicalday/owenloop/commit/847a1fabdd41ba7a021b967ba0c55e5f25526bb5))
* add deterministic workflow bundles ([#106](https://github.com/typicalday/owenloop/issues/106)) ([dfc598b](https://github.com/typicalday/owenloop/commit/dfc598b1ecf040d4c635cdb52443bdb0191f398b))
* add enrollment chain validation, attenuation, and revocation ([#117](https://github.com/typicalday/owenloop/issues/117)) ([2bc10c8](https://github.com/typicalday/owenloop/commit/2bc10c8226fe4960e9655e3672ebd0a17a7ed512))
* add signed origin records for published bundles ([#119](https://github.com/typicalday/owenloop/issues/119)) ([a5fbd8f](https://github.com/typicalday/owenloop/commit/a5fbd8fd5b5cec199e3028e8784a13662dcae58e))
* add signed submission records ([#121](https://github.com/typicalday/owenloop/issues/121)) ([f171227](https://github.com/typicalday/owenloop/commit/f171227a8ca1bf4f4f0c84edecf482c245ab203e))
* add signed workflow bundle publication ([#112](https://github.com/typicalday/owenloop/issues/112)) ([224f7a8](https://github.com/typicalday/owenloop/commit/224f7a834c747d954d1cf77316f0066e5252f09e))
* add SSHSIG signing, DSSE envelopes, and principal keys ([#102](https://github.com/typicalday/owenloop/issues/102)) ([5125545](https://github.com/typicalday/owenloop/commit/51255459ac21012365b6984d444efc0ae51dfa15))
* add v2 multi-workflow delivery bundles ([#127](https://github.com/typicalday/owenloop/issues/127)) ([26a59d7](https://github.com/typicalday/owenloop/commit/26a59d7bb9728fd4936d8d4eb2b2bb158983ff89))
* converge Claude Code and Codex plugins ([#113](https://github.com/typicalday/owenloop/issues/113)) ([1c6623d](https://github.com/typicalday/owenloop/commit/1c6623dff9649a4311382fa34c4bc6ac489a4f9f))
* enforce harness policy ([4f8796f](https://github.com/typicalday/owenloop/commit/4f8796f6415a486aad92725eec842d8a22e504f8))
* enforce local workflow instruction resolution ([#111](https://github.com/typicalday/owenloop/issues/111)) ([c5827d7](https://github.com/typicalday/owenloop/commit/c5827d7dd248ebc49a3a199dd8f1231249f280b5))
* enforce workflow origin policy at install and execution ([#122](https://github.com/typicalday/owenloop/issues/122)) ([d91e881](https://github.com/typicalday/owenloop/commit/d91e881583efabbe1efe3427d3fc69fd20f1d6fc))
* enforce workflow publication trust at install and execution ([#114](https://github.com/typicalday/owenloop/issues/114)) ([3b0d931](https://github.com/typicalday/owenloop/commit/3b0d931f6b37ca48b6c50a5b33a8b461e3410b8b))
* expose installed bundle assets to workers ([#125](https://github.com/typicalday/owenloop/issues/125)) ([2c8b498](https://github.com/typicalday/owenloop/commit/2c8b4981c1a395b78205c8b076893ac3efa4416f))
* expose run identity to command children ([#131](https://github.com/typicalday/owenloop/issues/131)) ([e7e18c1](https://github.com/typicalday/owenloop/commit/e7e18c1a84ce772fac80dfb493f267d7fbd8cde2))
* freeze launch wire contracts ([#110](https://github.com/typicalday/owenloop/issues/110)) ([571a8f9](https://github.com/typicalday/owenloop/commit/571a8f90532d90e3db786890885d31d3446edf21))
* reference-mode orders — instructions resolve by defDigest (WP-B1) ([#101](https://github.com/typicalday/owenloop/issues/101)) ([5e4071e](https://github.com/typicalday/owenloop/commit/5e4071ee5e56753cbcc330ac3c0b749518355ffc))
* register signed machine enrollments ([#116](https://github.com/typicalday/owenloop/issues/116)) ([25ef244](https://github.com/typicalday/owenloop/commit/25ef2442de6277001c24b9e375513bfcb20a0ef1))
* resolve agent model tiers and retry escalation ([#128](https://github.com/typicalday/owenloop/issues/128)) ([3098494](https://github.com/typicalday/owenloop/commit/3098494f2d34c3abdbe7ae2adee0deb73156f9b8))
* resolve CAS bundle workflows through calls: ([#130](https://github.com/typicalday/owenloop/issues/130)) ([444b868](https://github.com/typicalday/owenloop/commit/444b868f50b37e2e377976a935bf17ea60fe6190))
* ship Claude Code plugin pack ([#104](https://github.com/typicalday/owenloop/issues/104)) ([a76bea7](https://github.com/typicalday/owenloop/commit/a76bea789eaa78599b8ed23f590f5f559b907279))
* ship the Codex plugin tree and launch the plugin MCP server from PATH ([#107](https://github.com/typicalday/owenloop/issues/107)) ([d165d28](https://github.com/typicalday/owenloop/commit/d165d284d125304321b3c5d10a304cc3d606e0e3))
* support dynamic workdirs from consumed artifacts ([#129](https://github.com/typicalday/owenloop/issues/129)) ([6c4ada1](https://github.com/typicalday/owenloop/commit/6c4ada1478e4a2c1468c1565a6542ae3936ac383))
* two-level content-addressed workflow store with .wnlp bundle installs ([#103](https://github.com/typicalday/owenloop/issues/103)) ([029d06c](https://github.com/typicalday/owenloop/commit/029d06cfebcad2aeff20350a0f9c83402ede1b3a))
* verify admin-signed org policy floors and merge them as a strictness floor ([#120](https://github.com/typicalday/owenloop/issues/120)) ([da381b3](https://github.com/typicalday/owenloop/commit/da381b36d160de02a967926da71a6da6c19b21b8))
* verify consumed artifact values and producer enrollment at the driver boundary ([#123](https://github.com/typicalday/owenloop/issues/123)) ([9629d14](https://github.com/typicalday/owenloop/commit/9629d1444e5576629336dfbc31dcc3d1b0297a4c))


### Bug Fixes

* allow packaged plugins through npm publish gate ([#139](https://github.com/typicalday/owenloop/issues/139)) ([ef83b67](https://github.com/typicalday/owenloop/commit/ef83b67c5f491783c9d88b2f3fa0fa0c4ef2c582))
* inherit producer policy in native judges ([152eee1](https://github.com/typicalday/owenloop/commit/152eee148b1d269b45f5bb2ef4fae92efe830007))
* lock plugin manifest versions to package ([#108](https://github.com/typicalday/owenloop/issues/108)) ([8c2a93e](https://github.com/typicalday/owenloop/commit/8c2a93ea9f92293ac06c578d54384c381dd52f42))
* make hosted Shift delivery reliable ([#132](https://github.com/typicalday/owenloop/issues/132)) ([a8e3fc3](https://github.com/typicalday/owenloop/commit/a8e3fc318d581cb858b81d627d6b237ae8c9c757))
* resolve publishing hubs without project bindings ([#133](https://github.com/typicalday/owenloop/issues/133)) ([15795fd](https://github.com/typicalday/owenloop/commit/15795fda0f3c4835aacaeb0e905bfb1495ac2783))
* resolve the MCP hub origin from config instead of enumerating the credential store ([#118](https://github.com/typicalday/owenloop/issues/118)) ([07c140d](https://github.com/typicalday/owenloop/commit/07c140db6ba7169cba68eb09034dc23c70fdba28))
* select workflow versions deterministically ([#138](https://github.com/typicalday/owenloop/issues/138)) ([85e17c1](https://github.com/typicalday/owenloop/commit/85e17c149a1181ba745fd701d6a46be9dfcf5d05))

## [0.5.0](https://github.com/typicalday/owenloop/compare/v0.4.1...v0.5.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* **cli:** fold owenwork execution CLI into owenloop work ([#91](https://github.com/typicalday/owenloop/issues/91))
* **cli:** `owenloop binding rm` now requires a `<pool>` argument (`owenloop binding rm <label> <pool>`), and both `binding new` and `binding rm` print new stdout shapes. `binding new` no longer reports `previousPool`; scripts that read it must use `alreadyBound` / `boundPoolCount` instead. The CLI now requires a hub serving `add_label_binding` and `remove_label_binding`.

### Features

* add durable shift daemon ([#92](https://github.com/typicalday/owenloop/issues/92)) ([2c68808](https://github.com/typicalday/owenloop/commit/2c6880891d904067071904a3cfda8461ffc2587d))
* **cli,mcp:** selectable scopes for agent-identity minting ([#83](https://github.com/typicalday/owenloop/issues/83)) ([f9b7a55](https://github.com/typicalday/owenloop/commit/f9b7a559e9ab8f27bdaf15cf26dd6dcc8968c6a4))
* **cli:** fold owenwork execution CLI into owenloop work ([#91](https://github.com/typicalday/owenloop/issues/91)) ([1ed865a](https://github.com/typicalday/owenloop/commit/1ed865ae6d03cbb176d81e26f2ecce60a5cebd1c))
* **cli:** migrate binding commands to many-to-many label bindings ([6ba3cc2](https://github.com/typicalday/owenloop/commit/6ba3cc254f8874f8cb734d596b1b6d267c4b5946))
* **cli:** owenloop binding new|rm|list — label→pool bindings + author docs ([#85](https://github.com/typicalday/owenloop/issues/85)) ([c561861](https://github.com/typicalday/owenloop/commit/c561861c208d96d576997939e33063db8de1670b))
* **cli:** owenloop pool new|rm|list, pool member add|rm ([#88](https://github.com/typicalday/owenloop/issues/88)) ([8ad5fab](https://github.com/typicalday/owenloop/commit/8ad5fabc454650fed6f006b8b3b55d001d102d85))
* **mcp:** add pool tools (list_pools/create_pool/add_pool_member/remove_pool_member) ([#89](https://github.com/typicalday/owenloop/issues/89)) ([be2d667](https://github.com/typicalday/owenloop/commit/be2d6678d7da6de14bdb1a90f99c5077f1b95c86))


### Bug Fixes

* **cli:** unify add/push/check's definite-defect predicate via shared helper ([#81](https://github.com/typicalday/owenloop/issues/81)) ([0a43b99](https://github.com/typicalday/owenloop/commit/0a43b99bf3f7b615d74fe4f3780b775adf8c12a8))
* correct three vocabulary defects found in post-merge audit ([b43f5f6](https://github.com/typicalday/owenloop/commit/b43f5f696d74e35244ed7a355dcf106ad386f53b))
* **mcp:** sync presence_ping/list_conductors doc-text with hub behavior (W9.4) ([#87](https://github.com/typicalday/owenloop/issues/87)) ([72fc488](https://github.com/typicalday/owenloop/commit/72fc488c2fab055e64951482ff625483bdb927f1))
* repair and promote compile-dev-playbook, drop stray FUNDING.yml ([#99](https://github.com/typicalday/owenloop/issues/99)) ([7c78094](https://github.com/typicalday/owenloop/commit/7c780945841eb41467d508cac864b3262d5a8f38))

## [0.4.1](https://github.com/typicalday/owenloop/compare/v0.4.0...v0.4.1) (2026-07-22)


### Features

* **check:** default seedOwed inputs to assumed-provided, add --strict-inputs ([#80](https://github.com/typicalday/owenloop/issues/80)) ([1a0891f](https://github.com/typicalday/owenloop/commit/1a0891f280c5d0ccb942cb29ad734480238d652d))
* **check:** split dead steps into structurally-dead vs unreached-within-bounds ([#77](https://github.com/typicalday/owenloop/issues/77)) ([f7efb10](https://github.com/typicalday/owenloop/commit/f7efb10f922ea5a0baf04df839ce36fd0c626e82))
* **check:** split EXPECTED stall states from TRUE deadlocks in owenloop check ([#78](https://github.com/typicalday/owenloop/issues/78)) ([5933a67](https://github.com/typicalday/owenloop/commit/5933a67eeee9e654d3e4ba4c48854f6ef04b83b0))
* **cli:** agent new — mint an agent token into the credential store ([#75](https://github.com/typicalday/owenloop/issues/75)) ([f115cb9](https://github.com/typicalday/owenloop/commit/f115cb9739be28e29de5a7e1debd1155e4ab4a9f))
* **cli:** owenloop setup + doctor — shipped auth/setup experience (O4) ([#79](https://github.com/typicalday/owenloop/issues/79)) ([9a10d9a](https://github.com/typicalday/owenloop/commit/9a10d9ac618b6f31a5db5c106e3ae91bf44a3c6d))
* **defs:** flag silently-dead reduce and evaluator steps in validateDef ([#73](https://github.com/typicalday/owenloop/issues/73)) ([84c81f4](https://github.com/typicalday/owenloop/commit/84c81f46197792fe741bff7d74f5e30a537598d7))
* **hub:** credential write API + concurrency-safe OAuth refresh ([#71](https://github.com/typicalday/owenloop/issues/71)) ([9514571](https://github.com/typicalday/owenloop/commit/95145718492882cfd1088d540f54d639773e82a7))
* **mcp:** `owenloop mcp` stdio control-plane server (O2) ([#76](https://github.com/typicalday/owenloop/issues/76)) ([0daa66c](https://github.com/typicalday/owenloop/commit/0daa66c5fd32a64a40ab08ba9b393b77350fb91c))


### Bug Fixes

* **engine:** distinguish absent-from-fingerprint vs moved-version in born-reject reasons ([#74](https://github.com/typicalday/owenloop/issues/74)) ([1567b80](https://github.com/typicalday/owenloop/commit/1567b807accc11a71eb9f2cfd7930224577a67a0))

## [0.4.0](https://github.com/typicalday/owenloop/compare/v0.3.1...v0.4.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* `Keychain` methods take `(service, account)`, the `readStoredCredential` options argument is required and must carry a principal, and credentials stored under the previous keying are not read. There is deliberately no migration path — re-run `owenloop login`.

### Features

* **hub:** optional external command for hub credentials ([#69](https://github.com/typicalday/owenloop/issues/69)) ([bd52654](https://github.com/typicalday/owenloop/commit/bd526545983e055a479be2f93e1e644a2ee37131))
* principal-namespaced credential slots for hub credentials ([#68](https://github.com/typicalday/owenloop/issues/68)) ([253174f](https://github.com/typicalday/owenloop/commit/253174f33d51f90f1e051e85ff21a15b4d11e031))
* **store:** export read-only credential surface (readStoredCredential) ([#66](https://github.com/typicalday/owenloop/issues/66)) ([ed43efd](https://github.com/typicalday/owenloop/commit/ed43efdc7f305ca231f35f251c9d13886898d41a))

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
