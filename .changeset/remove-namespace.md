---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/sdk": minor
"@telorun/cache-redis": patch
"@telorun/http-dispatch": patch
"@telorun/lease": patch
"@telorun/record-stream": patch
"@telorun/shell": patch
---

Remove `metadata.namespace` as a structural field. Five subsystems read it;
each now uses something the module already has.

`x-telo-ref` names its target as an **alias-qualified kind** — the same grammar
`kind:` and `extends:` use: `KvStore.Store` for a module in this file's
`imports:` map, `Self.Store` for a kind in this library, `Telo.Invocable` for a
built-in. The analyzer canonicalizes each constraint in the *declaring* module's
scope before registration, so the definition registry answers ref queries with
no module context and a constraint stays correct whatever alias a consumer
picks. The legacy `"<namespace>/<module>#<Kind>"` identity form still resolves
for already-published module versions and now warns as
`X_TELO_REF_LEGACY_IDENTITY`; `metadata.namespace` feeds nothing else.

A constraint whose prefix names no alias is now `X_TELO_REF_UNRESOLVED` (or
`KIND_NOT_EXPORTED` when the alias is known but the target gates the kind),
quoting the slot's path and the aliases in scope. Previously — and for the old
identity form before it — an unresolvable constraint made the reference check
treat the slot as partial context and skip it, so a typo silently let the slot
accept any resource. All three diagnostics are scoped to the modules the author
can edit, so a published dependency never reports against its consumers.

Definition schema `$id`s move onto `telo://<module>/<Name>`, the scheme named
`Telo.Type`s already register under. One id space per module means a kind and a
named type may no longer share a name; that collision is reported as
`DUPLICATE_SCHEMA_ID` rather than silently dropping the type's schema.

Version reconciliation keys on the **import ref minus its version** rather than
`<namespace>/<name>`, so OCI and `https://` modules are hoisted for the first
time and two same-named modules published to different origins are no longer
conflated. A relative path addresses one file on disk, not a published
location, and is not reconciled.

`Transport.cacheLocation` is replaced by `Transport.cacheCoords`, returning the
`{ transport, host, path, version }` coordinates that `manifestCacheKey`
renders. The local manifest cache therefore uses the same layout as the
discovery hub's static bucket:
`.telo/manifests/<transport>/<host>/<path…>/<version>/<file>`. Registry entries
now carry the registry host, so two registries' copies of one path and version
no longer share a cache entry. **Existing `.telo/manifests` trees are orphaned
by the new layout and are re-downloaded on the next `telo install`.**

`telo publish` derives a relative sibling import's ref from the publish
destination — the destination's last segment is the module's own directory, so
`../bar` under `oci://ghcr.io/acme/foo` resolves to `oci://ghcr.io/acme/bar` —
and reads only the sibling's version from its manifest. `SiblingIdentity` is
gone.
