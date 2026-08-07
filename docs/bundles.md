# `.wnlp` bundle format

A `.wnlp` file packages one versioned package namespace, one or more named workflow definitions, and the regular files those definitions reference. The physical format is a gzip-compressed POSIX/PAX tar archive. Packing the same source bytes and canonical executable-bit choices produces identical archive bytes.

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

Each workflow definition is authoritative for that workflow's execution. A `bodyFile` reference in a step or judge is relative to the directory containing that workflow YAML file. For example, `bodyFile: instructions/writer.md` in `workflows/delivery.yaml` resolves to `workflows/instructions/writer.md`. The authored `bodyFile` and the resolved archive path must both satisfy the archive path safety policy. The packer and archive reader apply the same rule before parsing the workflow.

## `bundle.yaml`

The manifest is a package-only document. The manifest does not declare workers, commands, interpreters, scripts, or other execution behavior. Unknown keys, aliases, merge keys, tagged nodes, duplicate keys, non-string mapping keys, and invalid YAML are rejected.

The v2 shape is:

```yaml
formatVersion: 2
package:
  name: owenloop-delivery
  version: 1.0.0
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
- `workflows` is a non-empty map from workflow names to archive-relative YAML paths. Each workflow name matches `/^[a-z][a-z0-9-]*$/`. Each path must pass the shared archive path safety policy, and two workflow names may not point to the same path.
- A workflow file's `name:` must equal the workflow map key. For example, `workflows.delivery` must point to a file containing `name: delivery`.
- `default` is optional. When present, `default` must be one of the workflow map keys. When absent, a single-workflow package has that one workflow as its implicit default; a package with two or more workflows has no implicit default and callers must name a workflow explicitly.
- `platforms` is a duplicate-free list of portable selector strings. The list is advisory; platform policy is outside the package parser.
- `integrity.algorithm` is exactly `sha256`.
- `integrity.files` contains one lowercase 64-hex SHA-256 digest for every regular archive file except `bundle.yaml`. The packer regenerates this map from the source bytes and does not edit the source manifest. Excluding `bundle.yaml` avoids a recursive self-hash; the def digest still covers the complete canonical tar, including `bundle.yaml`.
- `capabilities` contains requested capability classes and values. The manifest does not grant capabilities.
- `lock` maps exact versioned `namespace/name@version` call references to lowercase 64-hex def digests. Every explicit versioned `calls:` target in every workflow must have a matching lock key. Bare calls remain governed by the workflow grammar.

Canonical manifest serialization uses a fixed key order, sorted mapping keys, sorted list values, JSON-style double-quoted strings, two-space indentation, and exactly one final newline. Inspection rejects a manifest that parses correctly but is not in that canonical byte form.

## Canonical archive

The def digest is the lowercase SHA-256 hash of the exact **uncompressed canonical tar bytes**. The gzip bytes are a transport encoding and are not the bundle identity.

For every regular file:

- Archive paths use `/` separators and are sorted by ascending UTF-8 bytes.
- Empty paths, NUL bytes, absolute paths, Windows drive paths, UNC paths, and `.` or `..` path segments are rejected. The same path policy is shared with GitHub archive extraction through `owenloop add`.
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

The gzip wrapper uses compression level 9 and has no optional filename, comment, or extra fields. Gzip mtime bytes are zero, and gzip header byte 9 (the OS byte) is explicitly forced to zero so Darwin and Linux produce the same bytes.

The canonical tar contains regular-file entries only. Parent directories are implied by `/`-separated file paths and are never emitted as tar entries. The strict reader rejects archive symlink, hardlink, device, FIFO, socket, directory, and unknown entry types. The packer rejects source symlinks and non-regular filesystem nodes. Absolute paths, `.` segments, and `..` traversal are refused rather than normalized.

The strict reader is as constrained as the writer. Every byte range parsed by the reader is limited to the exact form emitted by the canonical writer, including regular-file data padding and PAX-header data padding, which must be zero. This closes padding malleability: attacker-chosen bytes cannot sit inside the digest-covered tar while remaining absent from every per-file hash.

## Reading and extraction safety

`inspectBundle` and `unpackBundle` apply bounded compressed size, expanded size, tar-header count, per-file size, and path length limits before returning or writing file data. Strict readers reject malformed checksums and octal fields, truncated headers or data, malformed or dangling PAX metadata, duplicate paths, unsupported entry types, non-canonical headers, unsorted effective paths, trailing bytes, missing manifests, invalid manifests, missing or invalid workflows, unsafe workflow paths, workflow validation failures, and integrity mismatches.

`unpackBundle` validates the complete archive before filesystem writes. The destination must not already exist. The unpacker checks every existing destination ancestor and rejects operator-created symlinks, then writes into a fresh sibling staging directory. The staging directory is renamed into place only after all files are written; failed unpack operations remove staging and leave the destination absent.

## Installed-object verification on read

The store's bundle ingestor verifies an installed object again every time a resolver needs its contents. The verifier reads `bundle.yaml`, hashes every regular file, compares the result with `integrity.files`, and refuses the object when a listed file is missing or changed, when an unlisted file appears, or when any symlink, device, FIFO, or other non-regular node appears. The manifest itself is excluded from `integrity.files` by design because hashing the manifest would be recursive; the manifest is still required, regular, and strictly parsed.

A store index entry records the sorted workflow names alongside the package coordinate and bundle digest. Runtime instruction resolution reads the installed manifest and loads every listed workflow; a requested instruction digest may match any workflow in the installed object.

This check is separate from the read-only file modes applied during install. Changing an installed object on disk therefore produces an integrity refusal at resolution time, not a best-effort read and not an `unknown-digest` fallback.

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

`OWENLOOP_BUNDLE_DIR` is read-only. Workers must never write into the directory.
The workflow store is content-addressed and verifies the installed object again
when a resolver reads it. A write changes the object bytes, so the next read
fails the digest or file-integrity check instead of executing the modified
bundle. Mount or copy enforcement is not part of the current contract;
documentation is the enforcement boundary for now.

## API results

`packBundle(sourceDir)` returns:

- `bytes`: the complete gzip-compressed `.wnlp` file;
- `digest`: the canonical uncompressed-tar digest;
- `manifest`: the canonical manifest archived in `bytes`; and
- `entries`: sorted path, size, executable-bit, and per-file digest metadata.

`inspectBundle(bytes)` returns the digest, validated manifest, and entry metadata without writing files. `digestBundle(bytes)` performs bounded gzip inflation and returns only the def digest. `unpackBundle(bytes, destination)` returns the same inspection result plus the absolute materialized destination path.

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
