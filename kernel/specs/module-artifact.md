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
| `assets` | zero or one | the files the author claimed via `assets:` |
| `common` | zero or one | every remaining file `files:` selected |

`telo.yaml` MUST be its own layer. Without that, reading a manifest would pull
the whole artifact and selective fetch would be defeated at the first step.

A `controller` or `library` layer MUST carry a selector (§2). `assets` and
`common` are singletons and MUST NOT carry one.

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

A file that `files:` selected and that no controller candidate, no `exports.code:`
entry and no `assets:` pattern claimed MUST be placed in the `common` layer.

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
`exports.code:` entry — is chosen by:

```
selector := format , [ os ] , [ arch ] , [ libc ]
```

`format` is REQUIRED and names the artifact format the layer's files are in
(`js`, `napi`, `wasm`, …). The platform axes `os`, `arch` and `libc` are
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
is the only axis beyond the os/arch pair and exists because a glibc-linked binary
will not run on a musl host.

The set of **axis names** is closed; the set of **values** is deliberately open, so
a new architecture needs no specification change.

### 2.2 Canonical key

The canonical key of a selector is its `axis=value` pairs, sorted
lexicographically and joined with `;`:

```
arch=amd64;format=napi;libc=gnu;os=linux
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

## 3. The layer index

A published `telo.yaml` MUST carry a `layers:` block on its owner document
(`Telo.Application` / `Telo.Library`) listing every layer of the artifact **except
the manifest layer**. Order MUST be preserved, since §2.4 precedence reads it.

Each entry has:

| Field | Required | Meaning |
| --- | --- | --- |
| `role` | yes | one of `controller`, `library`, `assets`, `common` |
| `selector` | on `controller` and `library` only | §2 |
| `blob` | yes | the layer's transport blob digest, `sha256:` + 64 lowercase hex |
| `integrity` | yes | the layer's content digest, `sha256-` + 43 base64url characters |

### 3.1 Unknown roles are skipped, not rejected

An implementation MUST ignore an index entry whose `role` it does not recognize,
and MUST NOT fail the parse over one. Roles are added over time, and a runtime
that cannot name a role cannot need its layer — while rejecting would make the
whole manifest unreadable, so a module that gains a layer for a newer runtime
would stop loading on an older one entirely rather than merely lacking that layer.
Reading a manifest is the first step of every resolution, so this is the
difference between a degraded load and no load at all.

This applies to the role vocabulary only. A structurally invalid entry — a missing
or non-string `role`, a malformed digest, a selector that violates §2.1, a second
layer claiming one `(role, selector)` — remains an error: that is a malformed
index rather than a newer one.

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
independent of archive framing: the SHA-256 of the sorted `<path>\0<sha256(content)>`
lines of every file in the layer, rendered `sha256-<base64url>`. A runtime MUST
verify it before extraction, and MAY re-derive it from files already on disk — which
is what lets a cache validate an extracted layer without re-archiving it.

`telo.yaml` MUST be excluded from any `integrity` computation, so the manifest that
carries the index does not participate in a digest it contains.

### 3.4 Publish ordering

A publisher MUST push every payload layer, collect their `blob` digests, inject the
index into `telo.yaml`, and only then push the manifest layer. This ordering is what
keeps the index non-circular: it names only layers pushed before it.

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
- MUST record completion in a way keyed to the layer's `blob` digest, so a
  republish to different bytes re-extracts rather than being read as
  already-present;
- MUST write that record last, so an interrupted extraction re-runs;
- MUST serialize concurrent materialization of one module directory, within and
  across processes;
- SHOULD memoize in-process, since many resources of one module resolve against
  one layer concurrently.

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
- The **assets** layer and the **common** layer are materialized on the first
  module-relative file access. Assets alone is not sufficient — see §1.2.

A module whose assets are never read MUST NOT have its `assets` layer fetched. A
runtime MUST NOT materialize payload layers as a side effect of reading a manifest:
static analysis of a module reads its manifest and touches no payload.
