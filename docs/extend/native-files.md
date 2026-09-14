---
sidebar_label: Native Files
slug: /extend/native-files
description: "Declare a module's platform-specific files — prebuilt addons, shared libraries, per-platform data — once in a native: block, so publish ships each platform's file in its own layer and the platform-neutral bundle ships once."
---

# Native files

A module that needs a platform-specific file — a Node addon, a shared library
opened at run time, a per-platform data blob — declares it in a `native:` block
on its module doc. Each entry names one file for one platform tuple:

```yaml
kind: Telo.Library
metadata:
  name: SQLite
  version: 1.0.0
native:
  - name: better-sqlite3
    format: node
    os: linux
    arch: amd64
    libc: gnu
    abi: node-137
    path: ./native/linux-amd64-gnu-node-137/better_sqlite3.node
  - name: better-sqlite3
    format: node
    os: darwin
    arch: arm64
    abi: node-137
    path: ./native/darwin-arm64-node-137/better_sqlite3.node
```

The block is legal on `Telo.Library` and `Telo.Application`. Controller
candidates stay platform-neutral: the platform matrix is written once, however
many kinds the module has.

## The entry

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | the logical name the file is known by; lowercase letters, digits, `.`, `-`, `_`, starting with a letter or digit |
| `format` | yes | the file's format — `node` for an addon built against one Node ABI, `napi` for an N-API addon; other formats are open vocabulary |
| `os` | yes | operating system, in the OCI/GOOS vocabulary (`linux`, `darwin`, `windows`) |
| `arch` | yes | CPU architecture, in the OCI/GOOS vocabulary (`amd64`, `arm64`, `arm`) |
| `libc` | no | `gnu` or `musl`; Linux only |
| `abi` | no | the runtime ABI, as `<family>-<version>` (`node-137`) |
| `path` | yes | the file, relative to the module root |

`format`, `os`, `arch`, `libc` and `abi` form the entry's **selector** and are
read by the same rules as a bundled controller candidate's qualifiers:
values are lowercased, must be canonical tokens, and `abi` must have the
`<family>-<version>` form. The entry is closed — any other key is a schema
violation.

One name may have many entries, one per tuple. Several names may share a tuple.

## What `telo check` reports

Each rule has its own code, anchored at the offending entry. Only the entry
module's own block is checked; a dependency's block is its publisher's to fix.

| Code | When |
| --- | --- |
| `NATIVE_NODE_ABI_MISSING` | a `format: node` entry states no `abi` — the addon loads on exactly one Node ABI, so it must say which |
| `NATIVE_NAPI_ABI_FORBIDDEN` | a `format: napi` entry states an `abi` — an N-API addon is ABI-stable and states none |
| `NATIVE_LIBC_OFF_LINUX` | an entry states `libc` for an `os` other than `linux`, where libc is never determined, so it could never match |
| `NATIVE_ENTRY_DUPLICATE` | two entries of one `name` state the same selector |
| `NATIVE_PATH_SHARED` | two entries of different selectors share one `path` |
| `NATIVE_PATH_NESTED` | one entry's `path` runs through another entry's `path` as a directory |
| `NATIVE_PATH_CLAIMED` | a `path` is also a controller candidate's `path=`, an `exports.code:` entry's `path` or an `!include-*` embed in the same module — the message names that declaration |
| `NATIVE_PATH_ESCAPES_MODULE` | a `path` is absolute, a URL, or climbs above the module root |
| `NATIVE_ENTRY_INVALID` | an empty required value, a `name` or selector value outside the token grammar, an `abi` outside `<family>-<version>`, or a `path` that is a pattern or the module root |

Paths must differ per tuple, and none may be both a file and a directory,
because every layer of a module extracts into one module directory. Put the
tuple in the path: `./native/<os>-<arch>[-<libc>][-<abi>]/…`.

The N-API and libc rules are rules about a selector, so a bundled controller
candidate and an `exports.code:` entry report them too, as
`CONTROLLER_NAPI_ABI_FORBIDDEN` / `CONTROLLER_LIBC_OFF_LINUX` and
`LIBRARY_NAPI_ABI_FORBIDDEN` / `LIBRARY_LIBC_OFF_LINUX`.

## How publish partitions it

`telo publish` places each entry's file in the `native` layer of its selector,
one layer per distinct selector; the files of several names on one tuple share
that layer. The partition printout lists native layers beside the others:

```
controller js: 1 file(s)
native node (linux/amd64/gnu/node-137): 1 file(s)
native node (darwin/arm64/node-137): 1 file(s)
```

- A `native:` claim wins over `files:`, `assets:` and a controller `siblings=`
  pattern that select the same file — the file never lands in `common`,
  `assets` or a controller layer. The file does not need a `files:` entry.
- A file a `native:` entry names that a controller candidate's `path=`, an
  `exports.code:` entry or an `!include-*` embed also names is refused: a file
  ships in exactly one layer. `telo check` reports the same conflict as
  `NATIVE_PATH_CLAIMED`.
- An entry whose file no `sources:` entry stages and that is not on disk fails,
  naming the entry; at publish a file no source stages must also be tracked by
  git, and a staged one must be on disk and match its pin.
- The published `telo.yaml` carries the `native:` block unchanged, beside the
  generated `layers:` index, which lists one `role: native` entry per selector.

A module adopting `native:` declares `requires: telo:` at the release that
carries the block, since an older analyzer rejects the key on the module doc —
see [Runtime Requirements](./declaring-runtime-requirements.md).

## Reading a native file from a controller

Controller code asks for a file by its logical name and gets a `file://` URI:

```ts
import { fileURLToPath } from "node:url";

const uri = await ctx.resolveNativeFile("better-sqlite3");
const db = new Database(filename, { nativeBinding: fileURLToPath(uri) });
```

- **Which module.** The name resolves against the module that declares the
  controller the resource runs: the module declaring the resource's kind, or,
  for a kind that inherits its controller through a concrete `extends`, the
  ancestor declaring it. An application instantiating a library's kind gets the
  library's file, never one of the same name the application declares.
- **Which entry.** The first entry of that name, in declaration order, whose
  tuple matches the host. The Node kernel reports `abi` as
  `node-<process.versions.modules>`; under Bun `abi` is undetermined, so no
  entry stating an `abi` matches there.
- **From a published artifact** only that entry's `native` layer is fetched,
  verified against the layer index, and extracted.
- **From a source checkout** the file is read at the entry's path. When a
  `sources:` entry stages it, the file must match its pin: a missing or stale
  file is staged on first use — fetched from its source, written only once its
  bytes and execute bit match the pin — and an unpinned one fails, naming
  `telo release stage --pin`. Only the entry this host needs is fetched. When the
  module's `sources:` block does not read, no native file of the module is read,
  since the unreadable block may be the one staging it. A file no source names is
  checked in and read as it is; a checked-in symbolic link is read only when it
  leads to a file inside the module.

A prebuilt controller staged by `sources:` gets the same treatment before it is
opened: a `pkg:telo/local/napi` addon on the Node kernel and a
`pkg:telo/local/dylib` library on the Rust kernel. One whose archive cannot be
fetched falls through to the next candidate — a stale copy on disk is never
opened. One that carries no pin, or whose archive does not hold the pinned file,
is `ERR_STAGED_FILE_INVALID`; any other staging failure — a lock that could not
be taken, a write that failed — is `ERR_STAGING_FAILED`.

Every failure is `ERR_NATIVE_FILE_UNAVAILABLE`. When no entry matches, the
message names the host tuple and every tuple the module ships for that name:

```
Cannot resolve native file 'better-sqlite3' of module 'oci://ghcr.io/telorun/sqlite@<version>':
no entry matches this host (os=linux, arch=arm64, libc=musl, abi=node-141). The module ships
it for: node (linux/amd64/gnu/node-137); node (darwin/arm64/node-137). A host outside that set
needs a release of the module that ships a native layer for it.
```

`telo install --platform os/arch[/libc] --abi <family>-<version>` warms the
`native` layers matching that target alongside its code layers. Without
`--abi`, no layer stating an `abi` is warmed, and install reports each one it
skipped.

## Where the files come from: `sources:`

A prebuilt file is rarely checked in. A `sources:` block beside `native:` says
which pinned upstream archive each file is extracted from. A kernel reading a
source checkout fetches a file the first time it is needed, and
`telo release stage` fetches every one:

```yaml
sources:
  better-sqlite3:
    version: 12.8.0
    url: https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-{upstream}.tar.gz
    archive: tar.gz
    notices: [./notices/better-sqlite3.LICENSE]
    entries:
      ./native/linux-amd64-gnu-node-137/better_sqlite3.node:
        upstream: node-v137-linux-x64
        member: build/Release/better_sqlite3.node
        sha256: 4c9e0d…
        executable: false
```

The block is a map keyed by source name (a lowercase canonical token). Every
level is closed.

| Key | Required | Meaning |
| --- | --- | --- |
| `version` | yes | the upstream version, substituted for `{version}` |
| `url` | yes | an `https://` URL template — plain `http://` only for a loopback host; its only placeholders are `{version}` and `{upstream}` |
| `archive` | yes | the archive's format; `tar.gz` is the one format |
| `notices` | yes, non-empty | module-relative notice files covering what the source ships — checked in, or staged as entries |
| `entries` | yes | a map keyed by the module-relative path each entry produces |
| `build` | no | how the files are built in this repository, keyed by build system: `cargo` names the module-relative directory of the crate, and `inputs` is the digest of its build inputs, `sha256-<base64url>`, written by `telo release stage --pin` |

An entry is one of two shapes:

- **a file** — `upstream` (substituted for `{upstream}`) and `member` (the
  path inside the archive; an npm registry tarball nests everything under
  `package/`), plus `sha256` (64 lowercase hex characters of the file's bytes)
  and `executable`, both written by `telo release stage --pin`;
- **a link** — `target` alone, the link target exactly as it is stored,
  resolved relative to the link's own directory.

Entries are keyed by path because the manifest already names every staged file.
One `version` and one `url` serve every entry, so an upstream bump edits
`version` and re-runs `--pin`.

### What `telo check` reports

| Code | When |
| --- | --- |
| `SOURCE_URL_PLACEHOLDER_UNKNOWN` | the `url` uses a placeholder other than `{version}` or `{upstream}` |
| `SOURCE_URL_INSECURE` | the `url` is not `https://`, and not plain `http://` to a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`) |
| `SOURCE_ENTRY_UNCLAIMED` | an entry's path is not a `native:` entry's path, not the `path=` of a controller candidate carrying a platform qualifier, not selected by an `assets:` pattern, and not one of the source's own `notices` |
| `SOURCE_ENTRY_UNPINNED` | a file entry carries no `sha256` / `executable` — a kernel refuses to read it and publish to ship it |
| `SOURCE_BUILD_UNPINNED` | a `build` records no `inputs` — `telo release check` and publish refuse it |
| `SOURCE_LINK_TARGET_UNRESOLVED` | a link's `target` does not resolve to another entry of the same source, or resolves to one that ships in a different layer (another tuple's `native:` or candidate path, an asset, or a notice in `common`) |
| `SOURCE_LINK_CYCLE` | a link resolves to itself, or a chain of links never reaches a file entry |
| `SOURCE_ENTRY_INVALID` | an entry mixes the two shapes, a `sha256` is not 64 lowercase hex, `sha256` and `executable` are not written together, a required value is empty, or the path is not a single module-relative file |
| `SOURCE_ENTRY_DUPLICATE` | two entries — in one source or in two — produce the same path |
| `SOURCE_ENTRY_NESTED` | one entry's path runs through another entry's path as a directory |
| `SOURCE_INVALID` | a source name outside the token grammar, an empty `version` or `url`, a `url` that is not absolute, a notice path that is not a single module-relative file, a `build.cargo` outside the module, or a `build.inputs` that is not `sha256-<base64url>` |

An unknown key, a missing required field, an `archive` other than `tar.gz`, a
`build` naming no build system, empty `notices` or an entry with neither shape
is a schema violation. Only the entry module's own block is checked.
`SOURCE_ENTRY_UNCLAIMED`, `SOURCE_ENTRY_UNPINNED`, `SOURCE_BUILD_UNPINNED` and a
link whose target ships in another layer are rules about how the block meets the
rest of the module; every other rule makes the block unreadable, and a kernel
reads no native file of a module whose block does not read.

### Staging

```console
$ telo release stage                          # fetch and verify every module's sources
$ telo release stage --module modules/sqlite  # narrow to one module (repeatable)
$ telo release stage --pin                    # fetch every file entry and write its pins first
```

Plain `stage` walks the workspace's modules and, for each entry:

- fails when a file entry is unpinned, naming the entry and `--pin`;
- skips the fetch when the file is already on disk and matches its pin, so an
  unreachable upstream is fatal only for a file not yet staged;
- otherwise fetches the archive (once per URL per module), extracts `member`, and
  fails when it is missing, when its bytes do not hash to `sha256`, or when its
  executable bit differs from `executable`;
- writes the file with mode `0755` when executable and `0644` otherwise,
  creating directories, then creates the link entries, each once the file it
  leads to is staged.

A fetch — by `stage` or by a kernel staging on first use — follows at most ten
redirects, each vetted before it is requested by the rule `SOURCE_URL_INSECURE`
applies to the `url` and by `TELO_EGRESS`, and is bounded: five minutes, a
512 MiB response and 2 GiB decompressed. Every failure names the module and,
where one applies, the source, the entry path and the URL. Concurrent kernels —
and `stage` — serialize per archive URL, on a lock under the module's
`.telo/staging/`, and re-check before fetching, so an archive is fetched once
while entries from different archives stage side by side. A kernel prints one
line naming the entry, the module and the URL when a fetch starts.

`stage` stages every tuple, which is what publish reads; a kernel stages only
what its resolutions reach. A fresh clone therefore runs a manifest with no
staging step.

`--pin` fetches every file entry, writes `sha256` and `executable` — and each
`build`'s `inputs` — into `telo.yaml` as a byte splice, in block and flow
mappings alike, keeping the file's line endings, and nothing else in the file
changes. The edited text is read back with the same reader `telo check` uses and
written only when it carries exactly the pins computed, replacing the file in
one step. If any entry cannot be fetched, or the edit would not read back, the
manifest is left untouched. A following plain `stage` verifies.

Staged files are build output: a module adopting `sources:` adds its staged
paths to its own `.gitignore`.

### Staging a platform-neutral asset

A file every platform shares — a browser bundle a controller serves, a font
directory a library reads — is staged the same way and claimed by an `assets:`
pattern instead of a `native:` entry. It ships in the lazily fetched `assets`
layer, and its notice can be staged from the same archive:

```yaml
assets:
  - ./assets/
sources:
  scalar:
    version: 1.44.6
    url: https://registry.npmjs.org/@scalar/{upstream}/-/{upstream}-{version}.tgz
    archive: tar.gz
    notices: [./notices/scalar.LICENSE]
    entries:
      ./assets/scalar/standalone.js:
        { upstream: fastify-api-reference, member: package/dist/js/standalone.js, sha256: 0625…, executable: false }
      ./notices/scalar.LICENSE:
        { upstream: fastify-api-reference, member: package/LICENSE, sha256: 380c…, executable: false }
```

A controller reaches its own module's asset with `ctx.resolveControllerFile`,
which resolves against the module declaring the kind — not the application
that declared the resource, which is what `ctx.resolveModuleFile` resolves
against:

```ts
const uri = await ctx.resolveControllerFile("./assets/scalar/standalone.js");
```

From a source checkout, both calls and `!include-*` bring every module file a
`sources:` entry stages at or beneath the reference — one an `assets:` pattern
selects, or a notice — to its pin, staging a missing or stale one first, and fail
with `ERR_MODULE_FILES_UNAVAILABLE` when one is unpinned or cannot be staged. A
directory reference covers the module files inside it; a native file or a
prebuilt controller beneath it is left to its own resolution, which stages it for
this host alone. No module file resolves while the module's `sources:` block
does not read. From a published artifact the `assets` layer is verified against
the layer index instead.

A module adopting this declares `requires: telo: ">=0.91.0"`: an older
analyzer reports the entry as `SOURCE_ENTRY_UNCLAIMED`.

### Prebuilds of your own crates

A module that ships binaries built from a Rust crate in its own repository stages
them like any other prebuild — from the release assets the build published — and
names the crate under `build`:

```yaml
sources:
  starlark:
    version: 0.12.1
    url: https://github.com/telorun/telo/releases/download/starlark-v{version}/{upstream}.tar.gz
    archive: tar.gz
    notices: [./notices/starlark.NOTICE]
    build:
      cargo: ./rust
      inputs: sha256-Zitbq_WbjT8oRgJ7k0aZJEioihYBzGGZAOULeFUBwpg
    entries:
      ./native/linux-amd64-gnu/starlark.node:
        upstream: linux-amd64-gnu
        member: starlark.node
        sha256: 9c1e…
        executable: false
```

`telo release stage --pin` records `inputs`: a digest over the files git tracks in
the crate and in every path crate it reaches transitively — through a path
dependency (resolving `workspace = true` against the workspace root's
`[workspace.dependencies]`) or through a `[patch]` entry substituting a path crate
for a registry one — the `Cargo.lock` packages those crates reach through the
lock's dependency graph, every `.cargo/config`, `.cargo/config.toml`,
`rust-toolchain` and `rust-toolchain.toml` git tracks from the crate's directory
up to the repository root, and from the workspace root's `Cargo.toml` the
inherited `[workspace.dependencies]` entries, `[patch]`, `[replace]`, `[profile]`
and `[workspace]`'s `resolver`, `package` and `lints`. A lock entry or workspace
dependency no such crate reaches is not an input, and neither is a file git does
not track — build output, an ignored file or one nobody added — wherever it sits;
a crate git does not track at all is refused. `telo release check` recomputes the
digest from the manifests, without running cargo, and fails naming the module and
the source when it differs, so binaries are never published older than the code
that builds them. A change to a crate every controller depends on — the SDK, the
controller ABI — fails the check for every source built on it; a change outside
those inputs fails none.

Release commands digest a staged file from its pin, publish verifies the staged
bytes against it and never fetches, and the published `telo.yaml` carries no
`sources:` block — see [Releasing Modules](./releasing-modules.md#staged-files).
