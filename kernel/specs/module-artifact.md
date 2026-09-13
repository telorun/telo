---
description: "v1.0 spec: the layered module artifact — how a published Telo module is partitioned into layers, how the pinned layer index addresses and verifies them, and how a runtime selects the layers it needs"
---

# Telo Module Artifact Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines how a published Telo
module is laid out as an artifact and how a runtime — Node.js today, Rust and Go
later — locates, verifies and materializes the parts of it that runtime needs.
Two implementations that disagree here cannot load each other's published
modules, which is why the rules are normative rather than descriptive.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **RECOMMENDED** are to be interpreted as described in RFC 2119.

**In scope:** the layer model and roles, the selector grammar and its matching
rule, the `layers:` index shape, addressing and verification, the OCI mapping,
and materialization semantics.

**Out of scope:** how an author's `files:` / `assets:` patterns are matched (a
publisher concern), controller loading and the `pkg:` PURL grammar (see the
controller-delivery section of `CLAUDE.md`), and transports other than OCI —
layers are an OCI concept, and no other transport publishes a payload.

## 1. Layers and roles

A published module artifact is a set of **layers**. Each layer is an independently
addressable, independently verifiable archive of files, and a runtime MUST be able
to fetch any one of them without fetching the others.

Every layer has exactly one **role**:

| Role | Cardinality | Contents |
| --- | --- | --- |
| `manifest` | exactly one | `telo.yaml`, and nothing else |
| `controller` | zero or more | the entry-point files of the controller candidates sharing one selector, plus whatever their sibling declarations claim |
| `library` | zero or more | the entry point this module's `exports.code:` entry of one selector names — what a *dependent module's* code resolves this module's declared specifier to |
| `native` | zero or more | the files of every `native:` entry sharing one selector — platform-specific files the runtime does not import as code |
| `assets` | zero or one | the files the author claimed via `assets:` |
| `common` | zero or one | every remaining file `files:` selected |

`telo.yaml` MUST be its own layer. Without that, reading a manifest would pull
the whole artifact and selective fetch would be defeated at the first step.

A `controller`, `library` or `native` layer MUST carry a selector (§2), and there
is at most one layer of each such role per selector. `assets` and `common` are
singletons and MUST NOT carry one.

### 1.1 Why `library` is its own role

A module's controller entry points are reached only when one of *its* kinds is
instantiated. Its library entry point is reached when a **dependent** module's
code imports it, which can happen without this module's kinds being used at all.
The two are therefore materialized by different events, and a role is exactly the
thing a runtime keys materialization on.

It is per selector rather than a singleton for the same reason a controller layer
is: a module's `js` entry point and its future Rust one are different files, and a
consumer resolves the one its own runtime can import.

A file MAY be named by both an `exports.code:` entry and a `controllers:` candidate
— that is the normal shape, since a module is one bundle whose controllers are
selected by PURL fragment. Such a file MUST be placed in the `library` layer. That
is the weaker precondition: a consumer must reach it without loading this module's
controllers, while the reverse never holds.

### 1.2 The sink rule

A controller candidate's or an `exports.code:` entry's file is part of the payload
because the manifest names it. A publisher MUST include it whether or not `files:`
selects it — the manifest already declares it, and requiring both would mean
every module restates in `files:` what `controllers:` says. `files:` governs
what the manifest cannot otherwise name: assets, static files, sidecars.

A `native:` entry's file is part of the payload for the same reason, and a
publisher MUST place it in the `native` layer of that entry's selector — never in
`common`, `assets` or a code layer, even when `files:`, `assets:` or a sibling
declaration also selects it. Entries of several names sharing one selector share
that layer. A publisher MUST refuse a file a `native:` entry names that a
controller candidate, an `exports.code:` entry or an embed also names, since a
file extracts from exactly one layer, and MUST refuse a `native:` entry whose file
does not exist, naming the entry. The `native:` block is published unchanged.

The `sources:` block — where each staged file is fetched from — is authoring
input, and a publisher MUST remove it from the published `telo.yaml`, before any
digest of that text is taken: an importer's pin hashes the published text, so a
block no consumer reads would otherwise turn a moved upstream URL with unchanged
bytes into a new version of the module and of everything importing it. The
notice files each source names are part of the payload and belong in the
`common` layer. A publisher MUST refuse a staged file whose bytes or execute bit
do not match its pin.

A `native:` entry names a logical `name`, the selector axes `format`, `os`,
`arch` and optionally `libc` and `abi`, and a module-relative `path`, which is
the in-layer path. Because every layer extracts into one module directory (§5),
two entries of different selectors MUST NOT share a path, and no entry's path may
run through another entry's path as a directory.

A file that `files:` selected and that no controller candidate, no `exports.code:`
entry, no `native:` entry and no `assets:` pattern claimed MUST be placed in the
`common` layer.

A runtime MUST materialize the `common` layer whenever it materializes any of that
module's `controller` or `library` layers, **and** whenever it resolves a module-relative file
reference (§5.1). Both, because `common` is the sink for two different kinds of
unclaimed file: a controller's undeclared sidecar, and a static file the author did
not claim via `assets:`. A module that ships static files but has no bundled
controller would otherwise have no route to its own payload at all. This is what
makes the partition safe to derive: a
sidecar an entry point loads at runtime but the manifest cannot name — a `.wasm`
beside its glue, a native library opened by the dynamic linker — is on disk before
the controller that needs it is imported. A forgotten declaration therefore costs
bytes, never a load failure.

Both author declarations are OPTIONAL and only ever buy laziness. Omitting
`assets:` moves those files into `common`, where they are fetched alongside
controllers instead of on demand; omitting a sibling declaration moves that file
into `common`, where every controller-hosting runtime fetches it instead of only
the platform that needs it.

## 2. Selectors

A **selector** is the tuple a code entry — a `controllers:` candidate or an
`exports.code:` entry — or a `native:` entry is chosen by:

```
selector := format , [ os ] , [ arch ] , [ libc ] , [ abi ]
```

`format` is REQUIRED and names the artifact format the layer's files are in
(`js`, `napi`, `wasm`, …). The platform axes `os`, `arch`, `libc` and `abi` are
OPTIONAL.

### 2.1 Vocabulary and normalization

Every selector value MUST match `[a-z0-9][a-z0-9_.-]*` after normalization, and
normalization is lowercasing with surrounding whitespace removed. An implementation
MUST reject a value that does not.

`os` and `arch` values MUST use the OCI/GOOS vocabulary (`linux`, `darwin`,
`windows`; `amd64`, `arm64`, …), not a language runtime's own names. A runtime whose
host API reports different names (Node's `win32` / `x64`) MUST map them at its own
boundary.

`libc` distinguishes C-library ABIs where `os`/`arch` cannot (`gnu` vs `musl`). It
exists because a glibc-linked binary will not run on a musl host.

`abi` names the runtime binary interface a native file is built against. Its value
MUST have the form `<family>-<version>` — `node-137` for Node's
`NODE_MODULE_VERSION` 137, `telo-2` for version 2 of the Rust controller ABI — and
an implementation MUST reject a value that does not, wherever it reads a selector.
The family is part of the identity because a bare number is not one: Bun reports
`process.versions.modules` as `137`, exactly as Node 24 does, and loads none of the
addons built against it, and the Rust controller ABI is numbered on a scale of its
own. A value published into an artifact cannot be requalified later. A runtime
reports the `abi` it loads (a Node runtime `node-<process.versions.modules>`, a
Rust runtime `telo-<controller ABI version>`) and MUST leave it undetermined when
it cannot name its family with certainty, as a Node-compatible runtime that is not
Node cannot. A file whose interface is stable across runtime releases, such as an
N-API addon, states no `abi` and so matches every host.

The set of **axis names** is closed; the set of **values** is deliberately open, so
a new architecture needs no specification change. The axis names and any value form
an axis requires are published as data at `analyzer/artifact-axes/axes.json`, which
every implementation reads.

### 2.2 Canonical key

The canonical key of a selector is its `axis=value` pairs, sorted
lexicographically and joined with `;`:

```
arch=amd64;format=napi;libc=gnu;os=linux
abi=node-137;arch=arm64;format=node;libc=musl;os=linux
```

Two selectors are the same selector if and only if their canonical keys are equal.
An implementation MUST use this equality when grouping files into layers and when
detecting two layers claiming one selector. Equality of *layers* is `(role,
selector)`: a module's `js` controller layer and its `js` library layer are two
layers, and only a repeat within one role is a collision.

### 2.3 Matching rule

A selector matches a target — the host a runtime is on, or a platform a cache is
being warmed for — under one rule applied per axis:

- an axis the **selector** omits accepts any target value;
- an axis the selector states MUST equal the target's value.

An axis the **target** leaves undetermined therefore matches only a selector that
does not constrain it. An implementation MUST NOT guess an undetermined target
axis: refusing to match is the safe direction, since the alternative is handing a
host a native binary for an ABI it cannot run.

### 2.4 Precedence

When several controller candidates match a target, precedence is **declaration
order in the manifest**, so the author controls it. An implementation MUST NOT
reorder candidates by specificity or any other derived score.

The same rule selects a native file. Controller code asks for one by its logical
`name`, and a runtime MUST resolve that name against the `native:` block of the
module declaring the controller the resource runs — the module declaring the
resource's kind, or, for a kind inheriting its controller through a concrete
`extends`, the ancestor declaring that controller — and MUST NOT resolve it
against the module that declared the resource. Of the entries carrying that
name, the first in declaration order whose selector matches the host wins.

When no entry of that name matches, or the module declares no entry of that
name, a runtime MUST fail the request with `ERR_NATIVE_FILE_UNAVAILABLE`, naming
the name, the host tuple with each axis the host leaves undetermined marked as
such, and the tuple of every entry the module declares for that name. It MUST
NOT fall back to another module's entries or to an entry of another name: a
native file is not a candidate list, so there is nothing to fall through to.

A module loaded from a source checkout has no layers. A runtime reads the file at
the winning entry's path. When a `sources:` entry stages that path, the runtime
MUST verify what is on disk against the entry — a file's bytes against its
`sha256` and its execute bit against `executable`, a link's stored target against
`target`, following a link to the entry it names — before handing it out, and
MUST fail with `ERR_NATIVE_FILE_UNAVAILABLE` when the file is missing, unpinned
or does not match. When the module's `sources:` block does not read, a runtime
MUST NOT read any native file of the module, since the unreadable block may be
the one staging it. When no `sources:` entry stages the path, the file is checked
in and is read as it is — a symbolic link only when it leads to a file inside the
module. A runtime MUST NOT fetch a staged file: staging is a publisher's step, and
fetching at load would put an upstream's availability on the boot path.

A bundled controller candidate a runtime opens from a source checkout is subject
to the same rules when a `sources:` entry stages its `path=`: a file that is
unpinned or does not match, or a module whose `sources:` block does not read,
fails with `ERR_STAGED_FILE_INVALID` rather than falling through to the next
candidate; a staged file that is absent falls through.

## 3. The layer index

A published `telo.yaml` MUST carry a `layers:` block on its owner document
(`Telo.Application` / `Telo.Library`) listing every layer of the artifact **except
the manifest layer**. Order MUST be preserved, since §2.4 precedence reads it.

Each entry has:

| Field | Required | Meaning |
| --- | --- | --- |
| `role` | yes | one of `controller`, `library`, `native`, `assets`, `common` |
| `selector` | on `controller`, `library` and `native` only | §2 |
| `blob` | yes | the layer's transport blob digest, `sha256:` + 64 lowercase hex |
| `integrity` | yes | the layer's content digest, `sha256-` + 43 base64url characters |

### 3.1 Unknown roles and axes are skipped, not rejected

An implementation MUST ignore an index entry whose `role` it does not recognize,
and MUST NOT fail the parse over one. Roles are added over time, and a runtime
that cannot name a role cannot need its layer — while rejecting would make the
whole manifest unreadable, so a module that gains a layer for a newer runtime
would stop loading on an older one entirely rather than merely lacking that layer.
Reading a manifest is the first step of every resolution, so this is the
difference between a degraded load and no load at all.

An implementation MUST likewise ignore an index entry whose `selector` carries an
axis it does not recognize, and MUST NOT fail the parse over one. It MUST skip the
entry whole: it MUST NOT read the entry with the unknown axis dropped. The
rationale differs from the role rule, since a runtime can genuinely need a layer
whose axis it cannot name. It rests instead on direction. Skipping can never
mis-match: at worst the runtime lacks a layer and reports that where the layer is
needed. Dropping the axis turns the entry into a less constrained selector, which
matches hosts the layer was never built for, and collides two layers that differ
only in that axis onto one address.

These rules cover the role and axis vocabularies only. A structurally invalid
entry — a missing or non-string `role`, a malformed digest, a value of a
recognized axis that violates §2.1, a `controller`, `library` or `native` entry
with no selector, a singleton role with one, a second layer claiming one `(role, selector)`
— remains an error: that is a malformed index rather than a newer one. A skipped
entry is still checked where its structure does not depend on the vocabulary: its
digests MUST be valid, and so MUST the recognized axes of an entry skipped for an
unknown axis. The `selector` of an entry skipped for an unknown role is not
examined, since what a selector means is defined by its role: an implementation
MUST NOT reject such an entry over its selector.

### 3.2 Why the index lives in `telo.yaml`

A Telo import is pinned to a hash of `telo.yaml` and nothing else. In OCI the layer
list lives one level up, in the OCI manifest, which is fetched by a reference that
is usually a mutable tag and which Telo never hashes. Digests held only there would
leave the pin proving nothing about the payload: a republish could swap the layers
and every importer's pin would still verify.

Pinning the OCI manifest's own digest from `telo.yaml` instead is circular —
`telo.yaml` is one of its layers, so it would have to contain the hash of something
containing itself.

The **manifest layer has no entry** for the same reason: a hash of `telo.yaml`
cannot sit inside `telo.yaml`. It is covered by the importer's `#sha256-…` pin
instead. The chain is therefore:

```
import pin → telo.yaml → layer blob digest → layer contents
```

The selector MUST be pinned alongside its digests, i.e. inside the index. A
selector carried only as transport metadata could be relabelled without changing
any digest, handing a host a valid layer for the wrong platform.

### 3.3 The two digests

`blob` **addresses** the layer and verifies its transfer. A runtime MUST fetch a
layer by this digest and MUST verify the received bytes against it before
extracting them. Because addressing comes from the pinned index, a runtime MUST NOT
consult the transport's own layer list to decide which blob a layer is — which also
means a republish that reorders layers is invisible rather than fatal.

`integrity` verifies the layer's **contents**. It is computed over the file set,
independent of archive framing: the SHA-256 of one line per entry of the layer,
sorted and joined with `\n`, rendered `sha256-<base64url>`. A layer entry is a
regular file, an executable file or a symbolic link, and its line MUST be:

| Entry | Line |
| --- | --- |
| regular file | `<path>\0<sha256(content)>` |
| executable file | `<path>\0<sha256(content)>\0x` |
| symbolic link | `<path>\0l\0<target>` |

`<sha256(content)>` is the base64url digest of the file's bytes, and `<target>` is
the link's target exactly as the link stores it, unresolved. A file is executable
when any of its execute bits is set. A publisher reads that bit from the file's
mode, so a platform whose file system reports no execute bits publishes no
executable entries. The three forms cannot collide: a path contains
no `\0`, a digest is 43 base64url characters, and `l` is one character.

The regular-file line is the only form that existed before executable and link
entries, and it MUST NOT change: every `integrity` already published covers regular
files alone, so it still verifies. The other two forms exist because a digest that
omitted the execute bit or a link's target would let a cache revalidated from disk
accept a file that lost its bit, or a link that was repointed or replaced by a file.

A runtime MUST verify `integrity` before extraction, and MAY re-derive it from files
already on disk — reading a link as a link and never following it — which is what
lets a cache validate an extracted layer without re-archiving it.

`telo.yaml` MUST be excluded from any `integrity` computation, so the manifest that
carries the index does not participate in a digest it contains.

### 3.4 Publish ordering

A publisher MUST write the index into `telo.yaml` **before pushing anything**, then
push every payload layer, then push the manifest layer last. The ordering keeps the
index non-circular: it names only layers other than the one carrying it.

The index MUST NOT be written after the manifest bytes have been handed to the
push. An importer's pin is a hash of the published `telo.yaml`, and a dependent
derives that hash from the bytes its dependency's builder produced — so a rewrite
between the two makes every such pin name bytes no registry serves.

A `blob` digest is therefore known before the blob is pushed, which requires the
layer's archive framing to be a **pure function of the files it covers**: a
publisher MUST NOT let a clock, a path outside the layer, or any other ambient
input reach the framed bytes. A publisher SHOULD verify each pushed blob against
the digest the index already claims and MUST fail rather than correct a
disagreement, since the manifest may already be pinned.

## 4. OCI mapping

A module artifact is one OCI artifact manifest with a **flat layer list**. An
implementation MUST NOT require an OCI image index (manifest list) to represent a
multi-platform module: the manifest and asset layers are platform-neutral, so an
index would duplicate them per platform entry and add a round trip for a selection
made from the pinned index anyway.

Media types:

- manifest layer — `application/vnd.telo.module.manifest.v1+tar`
- payload layer — `application/vnd.telo.module.layer.v1+tar`

The manifest layer is the **only** layer located through the OCI manifest, by its
media type. Its bytes are then verified against the import pin, which is what makes
addressing the rest of the artifact from the index inside them safe: tampering with
the OCI manifest can only change which blob is offered as the manifest, and a
substituted one fails the pin.

Payload descriptors SHOULD carry `run.telo.layer.role` and
`run.telo.layer.selector` annotations so native tooling can read the artifact's
shape. An implementation MUST NOT read them back: role and selector come from the
index.

### 4.1 Pre-layers artifacts

A single-blob artifact carrying `telo.yaml` and its whole payload in one layer of
media type `application/vnd.telo.module.v1+tar` predates this specification. An
implementation MUST still read `telo.yaml` out of such an artifact, since that blob
contains it and the resolution path wants nothing else — a module with no payload
is fully usable from it, and refusing would break every module published before
layers existed rather than only the ones with payloads.

Such an artifact carries no index, so §5 has nothing to materialize from. An
implementation MUST report that as an actionable error naming republication at the
point a layer is actually needed — never by silently reading the payload out of the
single blob, which would reintroduce the atomicity this specification exists to
remove.

## 5. Materialization

**Materializing** a layer means fetching it, verifying it per §3.3, and extracting
its files into the module's local directory. Every layer of one module extracts
into the same directory, so a module-relative path resolves identically however the
module was delivered.

An implementation:

- MUST verify before extraction, never after;
- MUST reject an archive entry whose path escapes the module directory;
- MUST reject a layer carrying a symbolic link that breaks the link rule below,
  before extracting any of it, naming each such link's path and why;
- MUST extract a symbolic link as a symbolic link with its stored target, and MUST
  restore an executable file's execute bit;
- MUST record completion in a way keyed to the layer's `blob` digest, so a
  republish to different bytes re-extracts rather than being read as
  already-present;
- MUST write that record last, so an interrupted extraction re-runs;
- MUST serialize concurrent materialization of one module directory, within and
  across processes;
- SHOULD memoize in-process, since many resources of one module resolve against
  one layer concurrently.

**Entry paths.** Entry paths MUST be unique within a layer, and no entry's path MAY
have another entry's path of the same layer as a proper prefix of its directory
components (`b` and `b/x` cannot both be entries). Otherwise one entry stands where
another needs a directory, and a link standing there redirects every write beneath
it wherever the link points. An implementation MUST check every entry of a layer
against these rules and the link rule before writing any of it, and MUST confirm,
before each write or removal, that the real path of the entry's parent directory is
inside the real module directory, so a link already on disk cannot redirect it.

**The link rule.** A symbolic link MUST name a file of its own layer. Its target,
resolved against the directory holding the link, MUST NOT be absolute, MUST NOT
escape the module directory, and MUST be the path of another entry of the same
layer. When that entry is itself a link the rule is applied to it in turn, and the
chain MUST end at a regular or executable file of the layer; a chain that returns to
a link already visited breaks the rule. The rule rejecting an escaping entry path
says nothing about where a link points, and a target in another layer dangles
whenever that layer is not materialized, which §5.1 allows. A publisher MUST refuse
to publish a layer breaking the entry-path rules or the link rule, naming each
offending entry's module-relative path and why — for a link, whether its target
escapes the module, points at a directory, ships in another layer, or names
nothing.

### 5.1 When each layer is materialized

- The **manifest** layer is materialized when the module is resolved.
- A **controller** layer is materialized when a candidate matching its selector
  wins controller resolution — and the platform check of §2.3 MUST run *before*
  materialization, or a candidate list would fetch every platform's layer on the
  way to the right one. The module's `library` layer of that same selector MUST be
  materialized with it, since the winning candidate's file may live there (§1.1).
- A **library** layer is materialized when a *dependent* module's code resolves
  this module's declared specifier, at the selector of the code doing the
  resolving. A runtime MUST NOT require that module's controllers to be loaded
  first: a library-only module has none.
- The **common** layer is materialized with any controller or library layer of
  that module (§1.2).
- A **native** layer is materialized when a native file resolution (§2.4) selects
  an entry whose selector is the layer's — that layer alone, with no `common`
  layer: a native file is opened by path rather than imported, so it has no
  undeclared sidecar for the sink to deliver. The entry is selected before
  anything is fetched, so a module shipping a layer per platform fetches one. A
  cache warm for a target materializes every native layer whose selector matches
  that target.
- The **assets** layer and the **common** layer are materialized on the first
  module-relative file access. Assets alone is not sufficient — see §1.2.

A module whose assets are never read MUST NOT have its `assets` layer fetched. A
runtime MUST NOT materialize payload layers as a side effect of reading a manifest:
static analysis of a module reads its manifest and touches no payload.
