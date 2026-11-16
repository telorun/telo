---
description: "Normative spec of manifest migrations: the core JSON layer, the library stage declared by `migrations:`, recognition, the change, hand-over, fixpoint, failure, write-back and the Rust build's refusal"
---

# Telo Manifest Migrations Specification

## 0. Status and scope

This specification binds every implementation that loads manifests, in either language and in the browser. It defines how a legacy spelling is rewritten to the current one at load and what is reported. The guide is `docs/extend/manifest-migrations.md`.

The key words **MUST**, **MUST NOT**, **SHOULD**, **MAY** are per RFC 2119.

## 1. Two layers

1. **Core layer.** Data entries (JSON, no code) rewriting the grammar loading itself depends on: tags, definitions, annotations and the built-in documents. Each file is run through them after parsing and before desugaring, precompilation and every analysis. An entry names kinds only as document-kind filters; it MUST NOT name a library's kind.
2. **Library layer.** A `migrations:` map on a `Telo.Library` document, rewriting the library's own types as every consumer spells them.

The core layer MUST finish for a file before the library layer sees the graph. A `Telo.Application` declaring `migrations:` is `SCHEMA_VIOLATION`.

## 2. Declaration

`migrations` is a map from a code (an upper-case `A_B`-style name with at least two `_`-separated parts) to `{ reason, severity?, rules }`. The code is the migration's only identity. `severity` is `info`, `hint` or `warning` (default `warning`). `rules` is a non-empty list of items with `rewrite` as the required key.

A rule is `{ rewrite, match, before?, resolve?, remove?, move?, copy?, set? }`.

- `rewrite` and `before` MUST be `Self.<Name>`.
- `match` is a closed matcher: `type`, `required`, `const`, `enum`, `properties` and `items` holding the same vocabulary, with `<key>: false` under `properties` meaning absent. Any other key is `SCHEMA_VIOLATION`. A tagged or compiled value satisfies `required` and never `type`, `const` or `enum`. The matcher is evaluated as data; the vectors are `analyzer/library-migration-conformance/matcher.json`.
- `remove` is a list of pointers; `move` and `copy` map a source pointer to a destination pointer; `set` is literal data and a tag in it is `SCHEMA_VIOLATION`.
- `resolve` is `{ <binding>: { at, before? } }`.

A migration is not exported and not gated; it applies to every file whose import closure reaches the library, published dependencies included.

## 3. Candidates and recognition

A candidate of a kind is any declaration of it the analyzer reads: top-level documents, inline declarations at slots and at an import's `resources:`, template-body entries, `with:` members, and each branch of `!if` / `!switch` / `!for-each`. A candidate of a shape is a value at a position a current kind schema types by that shape. Inside a value typed by an own type and inside the body of a no-longer-declared own kind, every position the current schema does not type is a legacy position: a map there whose `kind:` resolves canonically to an own type is a candidate; a foreign `kind:` is carried as written; a position typed by an open schema is typed and never scanned.

Identity is canonical through the reading file's alias and re-export tables, bound per import edge. A rule reaches only its own module's types; foreign content in a matched node may be moved or copied, never read or changed.

A rule **recognizes** a candidate when its `match` holds and every `resolve` entry with `before` finds its referent rewritten by that type's hand-over rule (section 6).

A `rewrite:` naming no declared type is a removed kind only when some rule rewriting it writes `kind:` at its root. A removed shape is never a target.

A kind-only declaration (a Library `resources:` entry, a `needs:` entry) naming a removed kind is retyped to its replacement: the kind written at the root by every non-hand-over rule of it, followed while removed. A replacement that is not exactly one declared kind leaves the entry as written with `MIGRATION_FAILED`.

## 4. The change

Result of a rule on a node, in one step from the node as found (descendants already migrated bottom-up) and its bindings:

1. delete each `remove` pointer and each `move` source (an absent pointer is a no-op);
2. merge `set` (maps merge recursively, any other value replaces, `null` writes null);
3. place each moved or copied node unchanged at its destination (JSON Patch `add`: member set, index inserts, `-` appends, missing containers created). A missing source writes nothing.

Everything not mentioned is kept. A `kind:` in `set:` is library-relative and written in the consumer's alias; at the declaration's root it replaces the kind and `metadata` is kept. A destination already held by the node (and not removed), two writes reaching one position, a `set` merging into a non-map, a data read of a tagged or compiled value, a binding whose referent is neither a `!ref` nor a map with `kind:`, an unspellable kind (no alias names the library), a result failing the current schema, and a leftover match are failures (section 8).

## 5. Bindings

`resolve.<b>.at` is a pointer into the matched node to an inline declaration or a `!ref`. Without `before` the referent is read as migrated; with `before: Self.<T>` it is read as it was before the hand-over rule of `<T>` of the same migration. A `copy` source is `<binding>#<pointer>`; a `move` source is never a binding. A cycle among binding reads, or a failed referent, is a failure at each node involved. A referent in the same module instance is migrated first; referents in dependencies are already current (modules are processed in import post-order).

## 6. Hand-over

The hand-over rule of a type is the first rule of that type in a migration that another rule of the same migration reads with `before`; later rules of the type are fallbacks.

The members of a referent are every `!ref` in its module instance resolving to it (resolved as the analyzer resolves `!ref`, in any branch, at any slot, `targets:` entry, step `invoke:`, `with:` slot or import supply) and every `exports.resources` entry naming it. A CEL read of `resources.<referent>` is not a member.

The hand-over rule MUST fire on a referent only when it has at least one member, every member position is the `at` of a `before` binding of that type in a rule of the same migration that fired on the node holding it and converged, and every rewritten node passes the current schema; the group is committed whole or not at all. Otherwise the referent takes its fallback rule, the nodes holding a member are left as written, and with no fallback the referent is a failure naming the position that kept the hand-over from firing. Content MUST NOT cross a module-instance boundary: a supplied referent and an exported one keep their content on themselves.

## 7. Order and fixpoint

Each node is brought to a fixpoint: apply the first rule, ordered by migration code then position, whose target types the node, whose recognition holds for the node's current value and that has not fired on it (a hand-over rule only when its hand-over fires). A rule fires at most once per node. When none applies and a recognition still holds the node is a failure. Produced content is walked in turn. A node reports one diagnostic per migration that fired, at the consumer's own line, with the migration's `severity`.

## 8. Failure

A failure leaves the node untouched and reports `MIGRATION_FAILED` at the node (at the `imports:` entry for a dependency's file), naming the migration and the cause; findings of the current schema under that node are held back. A kernel load raises `ERR_MIGRATION_FAILED` for the same failure.

## 9. Where it runs

The library stage runs once, over the loaded graph: after every file has gone through the core layer, after the whole import closure (`imports:` entries and scoped `Telo.Import` members) has loaded and module versions are reconciled, and before flatten, inline extraction, `!ref` resolution, choice expansion and every analysis pass; modules in import post-order. The definition registry and alias resolvers are built once before it and serve the analysis after it. There is one result per module source. The stage is part of the analyzer, MUST run in a browser, and MUST NOT run for a round-trip view. A closure declaring no `migrations:` costs nothing.

Only the entry module's own files report a diagnostic; every file is rewritten in memory, and provenance maps diagnostics onto the author's spans.

## 10. Library checks

The library's own analysis MUST report, each an error and never raised by a kernel load:

| Code | Refused when |
|---|---|
| `MIGRATION_MATCH_OVERLAPS_SCHEMA` | a `match` (or the `match` of a rule a `before` binding names) is not proved disjoint from the current schema of its target |
| `MIGRATION_KIND_FOREIGN` | a `set.kind` names a kind that is not declared, re-exported or a removed own kind |
| `MIGRATION_TYPE_UNKNOWN` | a `rewrite` names an undeclared type that is not a removed kind |
| `MIGRATION_BINDING_INVALID` | a `resolve.at` names no reference slot or required key, a `before` names a type no rule of the migration rewrites, a `copy` source names no binding, or a `move` source names a binding |

The proof reads the schema validation applies (author schema with injected `kind` / `metadata`, `extends` folded, `$ref` followed). A `oneOf` / `anyOf` is disjoint only when disjoint from every branch, an `allOf` when from any one part; a branch without `additionalProperties: false` refuses no extra key; an unjudged keyword accepts everything.

## 11. Write-back

`telo migrate <path>` writes only the named module's own files, Application or Library. The matched node's span is replaced by its converged value in the node's own style; an entry or item kept at the same key or index with an equal value keeps its original text; anything else is rendered fresh and a lost comment is reported (`comment dropped:`). A span holding an anchor or an alias is not written (`not written:`), and a hand-over with an unwritable member is not written at all. Every converged writable node is written; the exit status is `1` while a `MIGRATION_FAILED` anywhere in the loaded graph or an unwritten rewrite is pending, `0` otherwise. `telo upgrade` moves pins only.

## 12. A build that cannot apply a library migration

Ignoring a migration changes what a manifest means, so such a build MUST refuse, with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the library, the migration and the node, the `imports:` entry first reaching a library whose module doc declares `migrations:`, only where a node of the closure could be a candidate of a rule. A manifest holding only current spelling MUST check and run.

## 13. Retirement

There are no version stamps. Deleting a library migration is a breaking removal for any published dependent still in the old spelling.
