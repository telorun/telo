# Remove `metadata.namespace`

## Problem

`metadata.namespace` is a module-declared string that acts as half of a **global flat
identity** (`std/http-server`). Five subsystems read it, and each is better served by
something the module already has:

- `x-telo-ref` slots name their target as `namespace/module#TypeName`, resolved through an
  identity table in `analyzer/nodejs/src/definition-registry.ts`. This is a second kind-reference
  grammar competing with the alias form (`kind:`, `extends:`, `capability:`) — and because a
  module self-declares its identity string, two modules from different origins can claim the
  same one. The `!namespace && moduleName !== "Telo"` guard in `registerModuleIdentity` exists
  solely to stop an application hijacking the `telo` identity.
- Definition schema `$id`s are built from the identity, duplicating the `telo://<module>/<Type>`
  scheme that named types already use.
- Version reconciliation keys on `<ns>/<name>` and **skips namespace-less modules entirely**, so
  OCI and https modules are invisible to hoisting.
- `telo publish` reads it to place a relative sibling import.
- The local manifest cache encodes it as a structural path segment.

None of this needs a declared namespace. Modules reached over OCI or https have none at all,
and the hub already proved the point by re-keying its index on the location ref.

## Solution

**Kind references become alias-qualified.** `x-telo-ref` takes the same grammar every other
kind slot takes: an import alias (`KvStore.Store`), `Self` for the declaring library's own kinds,
or `Telo` for built-ins. A new analyzer pass modelled on `resolve-schema-type-refs.ts` walks each
`Telo.Definition` schema, resolves every `x-telo-ref` against the **declaring module's** alias
scope via `aliasesByModule`, and rewrites it to the canonical `<module>.<Kind>` key before
registration — exactly the pre-resolution `extends` already receives. Afterwards
`DefinitionRegistry.resolveRef` is an identity lookup for new-form refs, and the identity table,
`registerModuleIdentity`, the `targetNamespace` field on import edges, the `resolvedNamespace`
stamp in `flatten-for-analyzer.ts`, and the kernel's registration loop all lose their reason to
exist for anything but legacy support. Consumers (`validate-references.ts`,
`analysis-registry.ts`'s `capabilityForRef` / `acceptedKindsForRef`) take canonical kinds directly.

Every cross-module `x-telo-ref` in this repo already has a matching import alias except
`modules/http-dispatch`, which references `std/codec#Encoder` with no `imports:` block at all;
it gains a real `Codec` import, making an existing coupling explicit.

**An unresolvable constraint is an error.** A prefix that names no alias leaves a string matching no
registered kind, and the reference check reads an unknown target as partial context and skips it —
so a one-character typo would silently make the slot accept anything. `X_TELO_REF_UNRESOLVED`
(and `KIND_NOT_EXPORTED`, when the alias is known but the target gates the kind) closes that, quoting
the constraint, the slot's path, and the aliases in scope. An already-canonical value looks the same
as a typo at rewrite time — `kv-store.Store` names a module, not an alias — so the two are separated
after registration by asking the definition registry, which is also what keeps the rewrite idempotent.

**Legacy refs keep resolving.** The `namespace/module#TypeName` form stays supported for already-
published module versions: `metadata.namespace`, when present, still feeds the identity table, and
a `#`-form ref raises `X_TELO_REF_LEGACY_IDENTITY` naming the alias form to use. Like the unresolved
diagnostics, it is scoped to definitions in the entry's own modules — a published dependency is not
the consumer's to fix, and reporting it would flood `telo check` with unactionable noise. The field
is otherwise inert — never required, never validated, never written by tooling.

**Definition `$id`s** move onto `canonicalTypeSchemaId(module, name)`, unifying definition schemas
and named types under one scheme. No manifest in the repo writes such a `$ref`; only
`kernel/docs/resource-references.md` documents the old shape. Because the two id spaces were
previously disjoint, a kind and a named type in one module can now collide; definitions register
first, so the type would be the one silently dropped, leaving every `$ref` to that id validating
against the kind's schema. `DUPLICATE_SCHEMA_ID` reports it instead.

**Version reconciliation** rekeys on the transport-canonical ref minus its version, taken from the
import edge — `std/kv-store`, `oci://ghcr.io/acme/x`, the https path. This brings OCI and https
modules into hoisting for the first time and stops two same-named modules from different origins
being conflated. It is not a pure win: because the key compares ref *spellings*, a module imported
once by registry ref and once by relative path is two groups, as are a bare ref and the direct
registry URL it resolves to (relating those needs the configured registry base, which the pure,
browser-safe analyzer does not have). Both limits are stated at `refIdentity`.

**Publish sibling refs** derive from the destination. `canonicalizeSiblingRef` drops
`SiblingIdentity` entirely and takes only the sibling's version: it joins the publish destination
with the relative source, treating the destination's last segment as the module directory, then
pins the version. Publishing to `oci://ghcr.io/telorun/foo` with an import of `../bar` yields
`oci://ghcr.io/telorun/bar@<bar's version>`; the OCI transport's `resolveRelative` already does
this, and the registry transport gains the same URL-join rule instead of reading manifest metadata.

**The manifest cache layout** unifies on the analyzer's `manifestCacheKey` grammar
(`<transport>/<host>/<path…>/<version>/<file>`). `Transport.cacheLocation` is replaced by
`Transport.cacheCoords`, returning `ManifestCacheCoords`; `local-manifest-cache-source.ts` renders
segments through `manifestCacheKey`, so hub tracker, editor read path, `telo module manifest`, and
the local install cache share one derivation. Registry entries gain the registry host as a segment —
today's layout omits it, so switching `--registry-url` silently serves another registry's bytes from
the same path. OCI entries become directories with a `telo.yaml` inside rather than a file named
after the tag.

The grammar gains two optional coordinates, each covering a case the hub's bucket never had. `file`
names the file within the version directory, defaulting to the module manifest: the local cache also
holds each `include:` partial, which has an arbitrary name. `version` is omitted for the https
branch — a URL's version lives inside the file, and the cache maps URL to path before any fetch, so
the reader cannot know it.

**Cleanup.** `metadata.namespace` is stripped from every manifest in this repo and from the
passive carriers (`kernel/nodejs/src/bundle/module-manifest.ts`, `apps/telo-editor/src/loader/parse.ts`,
`apps/telo-editor/src/model.ts`). Docs lose the namespace-tier doctrine in `kernel/docs/modules.md`
§6.2 and the identity model in `kernel/docs/resource-references.md`; `CLAUDE.md`,
`docs/extend/authoring-a-module.md`, and the authoring agent's system prompt
(`apps/authoring-agent/chat/telo.yaml`) are updated in the same change.

Registry ref addressing is untouched: `std/kv-store@0.3.0` stays, with `std/` an opaque path
prefix from the ref rather than a declared concept.

## Decisions

- **Alias-qualified over a bare module name (`kv-store#Store`).** One grammar for every kind
  reference instead of two; import-scoped resolution is correct for OCI/https/relative sources
  that have no registry namespace; and it makes the `telo`-identity hijack unrepresentable.
- **Rewrite in the analyzer before registration, not at lookup time.** Matches how `extends`
  already pre-resolves alias forms, keeps `DefinitionRegistry` module-context-free, and means the
  kernel needs no alias plumbing of its own.
- **Legacy `#` form kept with a deprecation warning, not hard-cut.** Every published stdlib
  version carries it; a hard cut would break any app importing a version published before this
  change until the whole ecosystem republishes.
- **A stale `metadata.namespace` is ignored, not rejected.** It is exactly the input the legacy
  path needs; erroring would break the compatibility above.
- **Publish sibling refs derived from the destination, with no replacement field.** The
  destination genuinely is the module's own location, so the coordinate is already present —
  adding `metadata.ref` would have been namespace under another name.
- **Cache-key grammar stays in `@telorun/analyzer`.** It is already browser-safe, already exports
  the helpers, and the kernel already imports from it in `local-manifest-cache-source.ts`. A
  dedicated `@telorun/module-ref` package was rejected as premature — revisit only if ref parsing
  keeps accreting.
- **Existing `.telo/manifests` trees are orphaned by the layout change.** Nothing prunes stale
  entries by design, so old paths become dead weight and the next `telo install` re-downloads.
  Acceptable pre-1.0; called out in the changeset.

## After the change

A definition slot that pins a contract:

```yaml
imports:
  KvStore: ../kv-store
---
kind: Telo.Definition
metadata:
  name: Once
schema:
  properties:
    store:
      x-telo-ref: KvStore.Store
    invoke:
      x-telo-ref: Telo.Invocable
```

A library referencing its own kind writes `Self.Store`. Cache paths for the same import set:

```
.telo/manifests/registry/registry.telo.run/std/kv-store/0.3.0/telo.yaml
.telo/manifests/oci/ghcr.io/acme/s3/1.2.0/telo.yaml
.telo/manifests/url/example.com/lib/telo.yaml
```
