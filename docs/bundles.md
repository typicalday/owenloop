# `.wnlp` bundle format

A `.wnlp` file packages one versioned package namespace, one or more named workflow definitions, and the regular files those definitions reference. The physical format is a gzip-compressed POSIX/PAX tar archive. Packing the same source bytes and canonical executable-bit choices produces an identical uncompressed canonical tar and therefore an identical bundle digest. The gzip wrapper's compressed payload depends on the zlib implementation linked by the running Node process and is not part of the bundle identity.

The bundle APIs are independent of the local workflow store and the network:

```ts
import { digestBundle, inspectBundle, packBundle, unpackBundle } from 'owenloop';
```

The command-line equivalents are documented in [`docs/cli.md`](cli.md#bundles).

## Source layout

A source directory must contain `bundle.yaml` and every path listed by the manifest's `workflows` map. Workflow paths may be at the source root or below a subdirectory. For example:

```text
report/
├── bundle.yaml
├── workflows/
│   ├── delivery.yaml
│   ├── init.yaml
│   └── instructions/
│       └── writer.md
└── schemas/
    └── findings.json
```

The packer recursively includes regular files below the source directory. The packer refuses symlinks, device files, FIFOs, sockets, and any other non-regular filesystem node. Directory entries are implied by file paths and are not stored in the archive.

Each workflow definition is authoritative for that workflow's execution. A `bodyFile` reference in a step or judge is relative to the directory containing that workflow YAML file. For example, `bodyFile: instructions/writer.md` in `workflows/delivery.yaml` resolves to `workflows/instructions/writer.md`. The authored `bodyFile` and the resolved archive path must both satisfy the canonical bundle path safety policy. The packer and strict archive reader apply the same rule before parsing the workflow.

## `bundle.yaml`

The manifest is a package-only document. The manifest does not declare workers, commands, interpreters, scripts, or other execution behavior. Unknown keys, aliases, merge keys, tagged nodes, duplicate keys, non-string mapping keys, and invalid YAML are rejected.

The v2 shape is:

```yaml
formatVersion: 2
package:
  name: owenloop-delivery
  version: 1.0.0
runtime:
  minVersion: "0.5.1"
  features:
    - harness-policy-enforcement.v1
    - native-judge-policy-inheritance.v1
workflows:
  delivery: "workflows/delivery.yaml"
  init: "workflows/init.yaml"
default: "delivery"
platforms:
  - darwin-arm64
  - linux-amd64
integrity:
  algorithm: sha256
  files:
    workflows/delivery.yaml: "<64 lowercase hex characters>"
    workflows/init.yaml: "<64 lowercase hex characters>"
    workflows/instructions/writer.md: "<64 lowercase hex characters>"
    schemas/findings.json: "<64 lowercase hex characters>"
capabilities:
  commands:
    - git
lock:
  example/research@1.0.0: "<64 lowercase hex characters>"
```

The following rules apply:

- `formatVersion` is exactly `2`. A v1 manifest is not accepted; there is no compatibility parser.
- `package.name` is a portable package namespace. The default store coordinate for the package is `package.name/package.name@package.version`; an explicit store namespace override may replace the first component. A workflow definition name is not the package name.
- `package.version` is a non-empty printable ASCII version string without path separators.
- `runtime` is optional. When present, `runtime` is a closed mapping that contains `minVersion`, `features`, or both; `runtime: {}` is invalid. Runtime requirements are described in [Runtime compatibility](#runtime-compatibility).
- `workflows` is a non-empty map from workflow names to archive-relative YAML paths. Each workflow name matches `/^[a-z][a-z0-9-]*$/`. Each path must pass the canonical bundle path safety policy, and two workflow names may not point to the same path.
- A workflow file's `name:` must equal the workflow map key. For example, `workflows.delivery` must point to a file containing `name: delivery`.
- An installed workflow is addressable from `calls:` by the qualified name `<package>/<workflow>`. A bare `calls: <workflow>` inside a CAS-installed bundle is resolved to a sibling from that same bundle; it does not search unrelated bundles for a same-named workflow. An exact versioned `calls: namespace/name@version` resolves through the verified store-index coordinate to the bundle's selected default workflow, then the engine checks the matching `lock` digest before creating the child.
- `default` is optional. When present, `default` must be one of the workflow map keys. When absent, a single-workflow package has that one workflow as its implicit default. A package with two or more workflows has no implicit default: the versioned coordinate is not registered as a callable target, while explicit `<package>/<workflow>` targets remain available.
- `platforms` is a duplicate-free list of portable selector strings. The list is advisory; platform policy is outside the package parser.
- `integrity.algorithm` is exactly `sha256`.
- `integrity.files` contains one lowercase 64-hex SHA-256 digest for every regular archive file except `bundle.yaml`. The packer regenerates this map from the source bytes and does not edit the source manifest. Excluding `bundle.yaml` avoids a recursive self-hash; the def digest still covers the complete canonical tar, including `bundle.yaml`.
- `capabilities` contains requested capability classes and values. The manifest does not grant capabilities.
- `lock` maps exact versioned `namespace/name@version` call references to lowercase 64-hex **bundle digests**. Every explicit versioned `calls:` target in every workflow must have a matching lock key. A bare same-bundle call has no lock entry: its pin is the containing bundle's own digest. The runtime compares bundle digests at child spawn; it does not compare this lock value with a per-workflow instruction digest.

Canonical manifest serialization uses the fixed top-level order `formatVersion`, `package`, optional `runtime`, `workflows`, optional `default`, `platforms`, `integrity`, `capabilities`, `lock`. Runtime fields use the order `minVersion`, then `features`; feature identifiers are sorted by ascending UTF-8 bytes. Other mapping keys and list values use their defined canonical order. Strings use JSON-style double quotes, indentation is two spaces, and the document has exactly one final newline. Inspection rejects a manifest that parses correctly but is not in that canonical byte form.

## Runtime compatibility

The optional `runtime` mapping declares requirements that the Owenloop process must satisfy before Owenloop returns usable workflow definitions or instructions:

```yaml
runtime:
  minVersion: "0.5.1"
  features:
    - harness-policy-enforcement.v1
    - native-judge-policy-inheritance.v1
```

The mapping is strict and closed. Unknown keys are rejected. At least one of `minVersion` and `features` is required.

- `minVersion` is exactly one canonical strict SemVer value. Ranges, a leading `v`, surrounding whitespace, and non-canonical forms are invalid. Owenloop compares the running package version with standard SemVer prerelease precedence; build metadata does not affect precedence.
- `features` is a non-empty, duplicate-free sequence. Each identifier is at most 128 UTF-8 bytes and matches `/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9][0-9]*$/`: lowercase portable segments ending in a positive, non-zero-padded `.vN` version.
- When both fields are present, both requirements must pass. The fields use AND semantics, not alternatives.

This Owenloop release advertises exactly these feature identifiers:

- `harness-policy-enforcement.v1`
- `native-judge-policy-inheritance.v1`

The running version comes from Owenloop's production `packageVersion()` source. A production build that cannot read a valid package version uses the `0.0.0` sentinel. The sentinel fails every declared `minVersion`, including `minVersion: "0.0.0"`, and the refusal tells the operator to install or upgrade Owenloop. The sentinel may still satisfy a feature-only declaration because feature support is evaluated independently.

Malformed runtime declarations fail with `BundleError.code === "MANIFEST_ERROR"`. A well-formed declaration that requires a newer Owenloop version or an unsupported feature fails with `BundleError.code === "RUNTIME_INCOMPATIBLE"`. Runtime-incompatible source bundles cannot be packed; runtime-incompatible packed bundles cannot be inspected, unpacked, installed, loaded as instructions, or executed. Definition listing and status discovery retain their existing fail-open behavior: they warn, skip the incompatible installed object, and continue loading unrelated definitions. Instruction and execution resolution fail closed before a command process, agent harness, or provider starts.

An absent `runtime` field preserves the previous canonical manifest bytes and bundle digest exactly. Adding, changing, or removing a present runtime declaration changes `bundle.yaml`, the canonical tar bytes, and therefore the content-addressed bundle digest. Readers that predate the runtime contract reject a present `runtime` key as an unknown top-level manifest key; authors must set requirements only when every required consumer supports this contract.

## Canonical archive

The def digest is the lowercase SHA-256 hash of the exact **uncompressed canonical tar bytes**. The gzip bytes are a transport encoding and are not the bundle identity.

For every regular file:

- Archive paths use `/` separators and are sorted by ascending UTF-8 bytes. A backslash is rejected as a character in a canonical bundle path; the reader never treats a backslash as an alternate separator.
- Empty paths, NUL bytes, absolute paths, Windows drive paths, UNC paths, and `.` or `..` path segments are rejected.
- A regular-file path may not be a complete-segment prefix of another regular-file path. For example, one archive cannot contain both `a` and `a/b` because `a` cannot be both a regular file and a parent directory.
- The canonical `.wnlp` path policy is deliberately stricter than the GitHub archive compatibility policy used by `owenloop add`. GitHub archive handling keeps its separate compatibility rules; ordinary backslashes that policy accepts are still invalid in canonical bundle paths.
- `uid` and `gid` are `0`.
- `uname` and `gname` are empty.
- `mtime` is `0`.
- Mode is `0644`, or `0755` when any source execute bit is set. Other mode bits do not affect the output.
- Short UTF-8 paths use canonical USTAR headers.
- Paths that do not fit the USTAR name field use one deterministic POSIX PAX `path` record in a `PaxHeader` entry.
- Header fields use canonical zero-padded octal values, USTAR magic `ustar\0`, version `00`, and zeroed link, device, and prefix fields.
- Each regular archive file uses typeflag `0`.
- Every entry's data padding, including the padding after a `PaxHeader` data record, is zero-filled.
- The archive ends with exactly two zero blocks and no bytes after the terminator.

The gzip wrapper uses compression level 9 and has no optional filename, comment, or extra fields. Gzip mtime bytes are zero, and gzip header byte 9 (the OS byte) is explicitly forced to zero so the gzip header bytes are identical across platforms. The compressed payload itself varies with the linked zlib implementation and is not the bundle identity; see the def digest above.

The canonical tar contains regular-file entries only. Parent directories are implied by `/`-separated file paths and are never emitted as tar entries. The strict reader rejects archive symlink, hardlink, device, FIFO, socket, directory, and unknown entry types. The packer rejects source symlinks and non-regular filesystem nodes. Absolute paths, `.` segments, and `..` traversal are refused rather than normalized.

The strict reader is as constrained as the writer. Every byte range parsed by the reader is limited to the exact form emitted by the canonical writer, including regular-file data padding and PAX-header data padding, which must be zero. This closes padding malleability: attacker-chosen bytes cannot sit inside the digest-covered tar while remaining absent from every per-file hash.

## Reading and extraction safety

`inspectBundle` and `unpackBundle` apply bounded compressed size, expanded size, tar-header count, per-file size, and path length limits before returning or writing file data. Strict readers reject malformed checksums and octal fields, truncated headers or data, malformed or dangling PAX metadata, duplicate paths, complete-segment file-prefix collisions, backslashes, unsupported entry types, non-canonical headers, unsorted effective paths, trailing bytes, missing manifests, invalid manifests, runtime-incompatible manifests, missing or invalid workflows, unsafe workflow paths, workflow validation failures, and integrity mismatches.

`parseManifestBytes` is the common runtime-admission boundary. Source packing, packed inspection, unpacking, workflow-store installation, installed-object verification, definition discovery, instruction lookup, and worker execution all pass through that boundary before returning usable definitions or instructions.

`unpackBundle` validates the complete archive before filesystem writes. The destination must not already exist. The unpacker checks every existing destination ancestor and rejects operator-created symlinks, then writes into a fresh sibling staging directory. The staging directory is renamed into place only after all files are written; failed unpack operations remove staging and leave the destination absent.

## Installed-object verification on read

The store's bundle ingestor verifies an installed object again every time a resolver needs its contents. The verifier safely enumerates every installed regular file, reads each file once, and preserves the existing detailed refusals for missing integrity-listed files, changed file digests, unlisted extra files, unsafe paths, symlinks, devices, FIFOs, and other wrong filesystem types.

After the per-file checks pass, the verifier reconstructs the complete canonical uncompressed tar from the installed files, including `bundle.yaml`. Installed non-executable files reconstruct as canonical mode `0644`; files with any execute bit reconstruct as `0755`. The SHA-256 digest of those canonical tar bytes must equal the object's `objects/sha256/<digest>` content address. This complete-object check covers runtime-only changes and removal of the runtime declaration even though `integrity.files` excludes `bundle.yaml` to avoid a recursive self-hash.

A store index entry records the sorted workflow names alongside the package coordinate and bundle digest. Executable definition discovery preserves each verified coordinate and fails closed on corrupt index or object state; read-only status inspection can skip damage only while reporting that its result is incomplete. Runtime instruction resolution reads the verified installed manifest and loads every listed workflow; a requested instruction digest may match any workflow in the installed object. A verification failure prevents the object from populating usable definition and instruction caches. Cache hits are re-verified, and a later failure evicts the cached object.

This check is separate from the read-only file modes applied during install. Installation maps canonical `0644` files to read-only `0444` and canonical `0755` files to read/execute-only `0555`, preserving the executable distinction needed to reconstruct identity. Changing an installed object on disk therefore produces an integrity refusal at resolution time, not a best-effort read and not an `unknown-digest` fallback.

An executable file installed by an older Owenloop release may already have lost its execute bit because older hardening mapped every regular file to `0444`. Reinstalling the exact original `.wnlp` is a supported atomic repair for that same-digest object. Owenloop first applies strict archive parsing, manifest and runtime admission, configured signature and policy verification, per-file integrity verification, and canonical digest verification to the supplied archive. Owenloop then reconstructs and completely verifies a clean staged object before replacing the broken destination through the normal journaled directory swap. The broken object's bytes are never reused. The prior object remains as the swap backup until the unchanged same-digest index state is durably committed; a failed repair restores the recoverable prior object and index state. A successful repair preserves the existing coordinate-to-digest mapping, and a later reinstall follows normal idempotent deduplication.

## Bundle assets during execution

When a command or agent step resolves its definition from an installed bundle,
owenloop sets `OWENLOOP_BUNDLE_DIR` to the verified installed object directory.
The directory is the bundle root, so a command can reference a shipped script with
an explicit quoted path:

```sh
node "$OWENLOOP_BUNDLE_DIR/scripts/provision.mjs"
```

owenloop sets `OWENLOOP_BUNDLE_DIR` only for definitions with installed-bundle
provenance. A definition without bundle provenance receives no value. Bundle
scripts must treat an unset or empty variable as a hard error and report a
message such as `this workflow must run from an installed bundle`; owenloop does
not synthesize a fallback directory.

Command and agent children receive two engine-derived identity variables:
`OWENLOOP_WORKFLOW` contains the workflow-instance id, and `OWENLOOP_RUN`
contains the run id. Both variables are always set, including for definitions
without bundle provenance. A command can read them directly:

```sh
printf '%s %s\n' "$OWENLOOP_WORKFLOW" "$OWENLOOP_RUN"
```

For agent children, admitting a name to `ADMITTED_OWENLOOP_KEYS` is only a
filter permission: `filterOwenloopEnv` permits an existing value through, but
does not make that value authoritative. `agent-run` sets both variables from
the worker's own engine-derived target before starting the child and overwrites
ambient values, so a nested agent receives its own identity rather than a
stale parent value.

Run identity is safe to expose because the engine derives it from the worker's
own `--order` argument. Consumed artifact values are attacker-influenceable, so
they reach a command child only through the environment block described in
[Consumed inputs for command steps](#consumed-inputs-for-command-steps), and
only after the consume-side gate below has admitted them. Command text is still
never interpolated with a consumed value.

`OWENLOOP_BUNDLE_DIR` is read-only. Workers must never write into the directory.
The workflow store is content-addressed and verifies the installed object again
when a resolver reads it. A write changes the object bytes, so the next read
fails the digest or file-integrity check instead of executing the modified
bundle. Mount or copy enforcement is not part of the current contract;
documentation is the enforcement boundary for now.

## Consumed inputs for command steps

A command step reads its consumed inputs from the environment, not from its
working directory. Exactly one of two variables is set on every command spawn,
and the other is removed:

| Variable | Set when | Value |
| --- | --- | --- |
| `OWENLOOP_CONSUMES` | the serialized inputs are **at or under** 65536 bytes (`CONSUMES_INLINE_MAX_BYTES`) | `JSON.stringify(order.consumes)`, inline |
| `OWENLOOP_CONSUMES_FILE` | the serialized inputs are **strictly larger** | absolute path to a `0600` UTF-8 file holding that same JSON |

The threshold is measured as `Buffer.byteLength(json, 'utf8')`, so a payload of
multi-byte characters is sized by its real byte length. Both variables are
always resolved, never left to inheritance: a shift launched from inside another
command step already carries its parent order's values, and a stale
`OWENLOOP_CONSUMES_FILE` would name a directory that no longer exists.

Because exactly one is present, the presence of `OWENLOOP_CONSUMES_FILE` is the
whole discriminator. A reader is four lines:

```js
const raw = process.env.OWENLOOP_CONSUMES_FILE
  ? readFileSync(process.env.OWENLOOP_CONSUMES_FILE, 'utf8')
  : process.env.OWENLOOP_CONSUMES;
const consumes = JSON.parse(raw ?? '{}');
```

Rules a script can rely on:

- The JSON parses to the raw `order.consumes` object with no wrapper, version
  field, or metadata — the same shape the `get_order` MCP tool serves an agent
  step under `order.consumes`.
- A step with no consumed inputs still gets `OWENLOOP_CONSUMES`, holding `{}`.
  Absent therefore means exactly one thing: read `OWENLOOP_CONSUMES_FILE`.
- An input a step declares but that was never produced is an **omitted key**,
  not a `null`. Test presence with `'key' in consumes`.
- The overflow file lives in a private temp directory that owenloop removes
  after the command exits. Read it during the run; do not stash the path.

These values are attacker-influenceable artifact data, which is why they travel
only in the environment block. Owenloop never puts a consumed value in argv or
in command text, and a command step's text is passed to `/bin/sh -c` exactly as
authored in the verified bundle. Delivery is gated: `resolveCommand` runs
consume-side verification under its hard rule and refuses the whole order when
the consumed evidence is absent, unverifiable, or invalid, so the environment
block is built only for an order whose inputs already verified.

## Working directory for command steps

An order carries a `workdir` when its step declared `workdir:` or
`workdirFrom:`. A command step that declared neither still runs, and the
command inherits the directory the operator was standing in when they ran
`owenloop shift start`. Nothing is enforced today: a future release will
require a step to declare that inheritance explicitly.

`workdirFrom:` is how a run tells a command step *where* to work. Its stem may
name a declared input, not only a consumed artifact, and that is the only
channel a run-supplied value has into a command step: `consumes:` is refused for
a human seed by the hard consumed-artifact gate above, and the `command:` string
reaches `/bin/sh -c` as authored bytes with no interpolation. A command step
that would otherwise be pinned to the one directory its shift was started in can
therefore take a project root per run — see
[authoring.md](authoring.md#workdirfrom--resolve-a-local-workdir-from-a-consumed-value-or-a-declared-input).

**Where the fallback is recorded.** When it fires, `owenloop work exec` writes
one warning per spawn naming the step, the workflow and run ids, and the
resolved absolute path. That warning goes to the exec worker's own stderr.

Where the exec worker's stderr goes depends on how the worker was started:

| How the step ran | Where the warning lands |
| --- | --- |
| `owenloop work exec <workflow>/<run>` run directly | the operator's terminal, on stderr |
| dispatched by `owenloop shift start` | `<log-dir>/<run>.log`, on disk |

Under shift dispatch, `createDefaultSpawner` in
`packages/work/src/shift/spawn.ts` opens `<log-dir>/<run>.log` for append and
hands that one file descriptor to the worker's stdio slots 1 and 2 — the same
redirection a shell writes as `2>&1`. The file outlives both the worker and the
shift. See [`docs/shift-logs.md`](shift-logs.md) for the directory layout,
`--log-dir` resolution, and retention.

The receipt still does not carry the warning, and that is by design rather than
a gap: the receipt captures the **command's** streams, and this warning is the
**exec worker's** own. The reverse is not symmetric: the worker also relays the
command's captured tail into its own output, so a command's last 4 KiB appears
in both the receipt and `<run>.log`. See [docs/shift-logs.md](shift-logs.md).

Two consequences worth stating separately:

- Do not read the absence of a warning **in a terminal** during a shift as
  evidence that a step resolved a `workdir` — under shift dispatch the warning
  was never going to appear in a terminal. Read `<log-dir>/<run>.log`, or read
  the order's `workdir` field.
- If the shift could not open a log (no writable log directory), the warning is
  discarded exactly as it was before on-disk logging existed. The shift reports
  that condition once on its own stderr and keeps dispatching.

Delivering this warning to a channel an operator can actually read was the
blocker on turning the fallback into a hard error. That half is now done. The
enforcement release — making a command step that declares neither `workdir:`
nor `workdirFrom:` fail instead of warn — remains a separate decision and has
not been made.

This section is about command steps only. An agent step resolves its working
directory through a different ladder (`packages/work/src/agent/workdir.ts`):
`OrderPacket.workdir`, then a per-run directory under the work root, then the
process cwd. It does not use the fallback described here.

## API results

`packBundle(sourceDir)` returns:

- `bytes`: the complete gzip-compressed `.wnlp` file;
- `digest`: the canonical uncompressed-tar digest;
- `manifest`: the canonical manifest archived in `bytes`; and
- `entries`: sorted path, size, executable-bit, and per-file digest metadata.

`inspectBundle(bytes)` returns the digest, runtime-admitted validated manifest, and entry metadata without writing files. `unpackBundle(bytes, destination)` returns the same inspection result plus the absolute materialized destination path.

`digestBundle(bytes)` is the deliberate identity-only exception to runtime admission. The function enforces the compressed and expanded size limits, inflates the gzip payload, and hashes the exact decompressed bytes. The function does not parse or validate a canonical tar and does not parse `bundle.yaml`; therefore `digestBundle` can return a digest for bounded gzip content that is not an admissible bundle, including an archive whose runtime declaration the current Owenloop process cannot satisfy. A successful digest does not mean the content is a canonical tar or that the bundle is admissible for packing, inspection, unpacking, installation, definition loading, instruction lookup, or execution.

`owenloop publish` signs exactly `packBundle(sourceDir).digest`: the lowercase 64-hex SHA-256 digest of the uncompressed canonical tar. It does not sign the gzip wrapper bytes or the separate compiled-definition hash used by `push`.

All bundle failures are `BundleError` instances with a stable `code` suitable for scripts. The CLI keeps that code in the stderr diagnostic.

## Limits

The default shared archive limits are:

| limit | default |
|---|---:|
| compressed input | 256 MiB |
| expanded tar | 1 GiB |
| tar headers | 50,000 |
| one regular file | 100 MiB |
| one path | 1,024 characters |

The in-process APIs accept `limits` overrides through `PackOptions` or `InspectOptions`. Limits apply before archive data is copied or extracted.

## Verification example

A package can be inspected with both owenloop and a stock tar implementation:

```sh
owenloop bundle inspect ./report-1.2.0.wnlp
owenloop bundle digest ./report-1.2.0.wnlp
tar -tzf ./report-1.2.0.wnlp
```

The digest printed by `owenloop bundle digest` is stable across gzip metadata, operating-system, and filesystem timestamp differences when the canonical file bytes and executable-bit choices are unchanged. CI recomputes a checked-in golden vector on both Ubuntu and macOS to guard this cross-platform stability.
