# Transitive re-export of resources (and kinds)

## Goal

A `Telo.Library` may re-export an instance it reached through one of its own
imports, so a consumer can target/reference it without knowing the owning
module. This must compose to **arbitrary depth** (`app → api → domain → core …`)
and resolve in **O(1)** per lookup, independent of re-export depth.

## Surface — plain dotted names

`exports.resources` entries are plain name strings (the `!ref` tag is rejected here,
matching `exports.kinds`):

```yaml
exports:
  resources:
    - Migrate              # export a locally-owned instance, name "Migrate"
    - Domain.Db            # re-export the instance reached via this lib's import
                           # aliased "Domain", under the name "Db"
```

A consumer importing this lib as `Api` then writes `!ref Api.Db` / `!ref Api.Migrate`
(consumers always reference instances with `!ref`; only the export *declaration* is a
plain name). Re-export composes because each hop just re-declares `<PrevAlias>.<Name>`.

## O(1) mechanism — flatten at registration

Each `ModuleContext` holds a precomputed table `exportedGetters: name → terminalGetter`,
where a *terminal getter* is a closure reading the **owning** context's
`resourceInstances` directly (lazy for instance, but zero hops to the owner).

- A **local** export gets a fresh terminal getter over `this.resourceInstances`.
- A **re-export** of `!ref Domain.Db` copies `Domain`'s terminal getter **by
  reference** into this table. So every module along the chain holds the *same*
  closure object pointing at the single owner.

Resolution of `!ref Api.Db` = alias lookup + one table lookup + invoke terminal
closure → **constant**, regardless of depth. Tables are built once per import
(after the child's own imports init, leaves-first), never on the hot path.

## Touch points

1. **Runtime** — `kernel/nodejs/src/module-context.ts` (export table + O(1)
   lookups), `controllers/module/import-controller.ts` (parse dotted exports,
   build table after child init, register terminal-getter scope).
2. **Analyzer** — `analyzer/nodejs/src/flatten-for-analyzer.ts` (transitive
   forwarding of re-exports stamped under the re-exporting module, so
   `!ref Api.Db` keys as `api\0Db` in `resolve-ref-sentinels.ts`).
3. **Editor** — `apps/telo-editor/src/analysis.ts` parity with the forwarding rule.
4. **Schema** — `exports.resources` entries stay plain strings (bare `Name` or
   dotted `Alias.Name`); the `!ref` tag is rejected there, mirroring `exports.kinds`.

## Kinds

Symmetric to resources, with `exports.kinds: [Alias.Kind]` as the surface (kinds aren't
`!ref`'d — they're referenced as `Alias.Kind`). Runtime: each `ModuleContext` holds a
flattened `exportedKinds: suffix → canonical <owner>.<Kind>` table, copied by reference up
the chain (O(1)); `resolveKind` applies it as a re-export *override* so unrestricted modules
and local kinds are unchanged. Analyzer: `resolveExportedKinds` computes the per-module
canonical map (fixpoint), `stampReExportedKinds` writes it onto each `Telo.Import`'s
`metadata.reExportedKinds`, and the analyzer registers `AliasResolver.registerKindReExport`.

## Status

Done — resources and kinds, runtime + analyzer + editor, transitive + O(1). Tests:
`tests/re-export-transitive.yaml` (instances), `tests/re-export-kind-transitive.yaml` (kinds).
