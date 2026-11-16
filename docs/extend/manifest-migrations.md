---
sidebar_label: Manifest Migrations
slug: /extend/manifest-migrations
description: "How a renamed keyword, annotation or library kind keeps loading: migrations rewrite a legacy spelling to the current one at load, report it in your own files, and telo migrate writes the repair back to disk."
---

# Manifest migrations

Telo occasionally renames something a manifest can say — a schema annotation, a keyword, a value grammar. Published artifacts carry the old spelling and cannot be edited, so a rename can never simply *replace* the old form.

A **migration** is how that rename ships. It is a matcher plus a patch: the loader finds every occurrence of the legacy spelling and rewrites it to the current one, in memory, before anything else reads the manifest. The old form and the new one then behave identically, on every kernel, for every artifact ever published.

This is deliberately not the same mechanism as a **normalization** — desugaring an `imports:` map, extracting an inline resource, resolving a `!ref` sentinel. Those fold authoring sugar into an internal form, are never written back to source and are correctly invisible. A migration is author-visible: it reports what it rewrote and offers a way to make the file say it.

Migrations come in two layers. **Core migrations** repair the grammar every manifest is written in — tags, definitions, annotations, the built-in documents — and are data files shipped with Telo. **Library migrations** repair a library's own vocabulary (its kinds and shapes) and are declared by the library, so they reach a consumer under whatever alias it imports the library as. A library migration is the way to rename or reshape what a library offers without breaking the manifests written against it.

## What an author sees

A manifest using a legacy spelling keeps working. `telo check` reports it as a deprecation, and `telo migrate` repairs the file:

```text
modules/mine/telo.yaml:15:13  warning  `type` is no longer used.
A reference is written with the `!ref` tag and resolves to an object, so a
reference slot no longer carries the scalar `type:` that plain-string references
were pinned to. Leaving it in place makes the slot reject the very value it is
declared to accept, and every schema reader has had to know to ignore it.
no quick fix (removes an entry) — run `telo migrate`  X_TELO_REF_SCALAR_TYPE
```

```text
$ telo migrate
ref-slot-scalar-type  modules/mine/telo.yaml  1 rewrite

1 rewrite in 1 file. Imported modules were not touched.
```

Three properties of that output are worth naming, because each is a rule rather than a nicety:

- **The squiggle is on the author's own line.** Analysis ran over the migrated tree, whose paths may differ from the file's, so every rewrite records the path it matched and diagnostics are mapped back through it before their position is resolved.
- **The warning is only about your own files.** A migration *rewrites* always — the runtime must read artifacts published years ago — but *reports* only for the manifest you named and its `include:` partials. A published dependency is not yours to fix, and its author is the only person who can.
- **Whether a quick fix exists is stated, not silently absent.** A key rename has no honest whole-value replacement, so the editor offers none and the diagnostic says why. `telo migrate` does that repair through the file instead.

## `telo migrate`

`telo migrate <paths..>` writes the repairs into the files of each module you name — core migrations first, then the **library migrations** that the libraries it imports declare about their own vocabulary (rewritten under whatever alias you import them as, over the module's whole import closure). A path may name a **Library** as well as an Application. Only the named module's own files (its entry file and `include:` partials) are written: a dependency is repaired by naming it, so a library's files are never changed through a consumer's load, whose reconciliation could put a spelling into them that the library's own pins refuse. Naming an application and its library, in either order, gives the same files.

```text
$ telo migrate telo.yaml
SQL_BEFORE_MIGRATIONS_RENAMED (sqlite)  telo.yaml  1 rewrite
  telo.yaml:18:1  comment dropped: # Backfill before `name` becomes NOT NULL.

1 rewrite in 1 file. Imported modules were not touched.
```

What a rewrite keeps and loses:

- The node's span is replaced by its converged value, rendered in the node's own style (block or flow, its indentation). An entry kept at the same key with an equal value, and an item kept at the same index with an equal value, keeps its original text byte for byte, comments included. Values that moved keep their text; everything else is rendered fresh.
- A comment inside a part that is rendered fresh is lost, and the command names each one (`comment dropped:`, with its file, line and column).
- A rewrite whose span holds an **anchor or an alias** is not written (`not written: <reason>`), and neither is anything in a hand-over group with such a member: the referent and every node that takes over what it drops are written together or not at all.

**Partial runs.** Every node that converged and is writable is written; a node that failed (`MIGRATION_FAILED`, in your own files or in a dependency's) or could not be written is left as written and reported, with its reason. The command exits `1` while anything is pending, and `0` otherwise; a second run reports nothing new. `-o json` carries `ok` (true exactly when the exit status is 0), `rewrites`, `unwritable` and, per file, each rewrite and each unwritable node with its `reason`, and `failed` for every `MIGRATION_FAILED`.

`telo upgrade` moves pins only. A node that needs a hand edit needs the new spelling, which only the new pin accepts, so withholding the pin until the repair succeeds would deadlock: upgrade first, then run `telo migrate`. When a migration reaches a library you own only because a consumer moved a dependency to a newer version, run `telo upgrade` on the library, then `telo migrate` on it.

The editor offers the same edit set as one quick fix, when none of it is unwritable.

## Writing a core migration

**A migration entry is one JSON file under `analyzer/migrations/`.** The set is read as one lexically ordered list, so adding a migration is one file and retiring one is deleting it — nothing lists the entries by hand. The files sit beside the language implementations rather than inside any one of them, because every kernel must apply the identical rewrite: a rewrite described twice, in two languages, is the divergence this design exists to prevent, and it would be invisible, since a migration that succeeds is silent. Both halves read the identical files: the Node analyzer imports them, and the Rust analyzer embeds them at build from the same directory listing.

JSON rather than YAML for one reason: it is the only format all three runtimes embed with no generation step. Rust has `include_str!` and Go has `//go:embed`; TypeScript has neither, and its only native embed is `resolveJsonModule`. Author notes go in `$comment` — the one top-level key the reader ignores; every other unknown key is refused.

An entry declares a stable **id**, a **diagnostic code** and **severity**, a **reason**, and one or more **rules**:

```json
{
  "id": "ref-slot-scalar-type",
  "code": "X_TELO_REF_SCALAR_TYPE",
  "severity": "warning",
  "reason": "A reference is written with the `!ref` tag and resolves to an object, so a reference slot no longer carries the scalar `type:` that plain-string references were pinned to.",
  "rules": [
    {
      "match": {
        "key": "type",
        "inKind": ["Telo.Definition", "Telo.Abstract"],
        "under": ["schema", "status", "inputType", "outputType"],
        "valueOneOf": ["string", "number", "integer", "boolean"],
        "withSibling": "x-telo-ref",
        "notUnder": ["const", "default", "enum", "examples"]
      },
      "patch": [{ "op": "remove-entry" }]
    }
  ]
}
```

**An entry contains no code.** Both halves are data — a predicate expressed in one language would be readable by one kernel only.

One entry is one deprecation *story*, and may carry several rules. That is why `reason` is entry-level: a rationale is true of every rule in the entry, where a mechanical description would have to vary per rule.

**Write only the `reason`.** The driver knows the matched key and value, the replacement, whether a quick fix is derivable and the location, so it generates *what changed* and *how to apply it* identically for every entry. What it cannot know is *why*.

### The operations

The patch is declarative, and the operations are named for what they **target**:

| operation | targets | parameters |
| --- | --- | --- |
| `rename-key` | the matched mapping entry's key | `to` |
| `set-value` | the value at the match | `value`, or `qualify` to prefix the existing string |
| `set-tag` | the matched scalar | `tag` (the engine name, no `!`), optional `source`: `text` (default — the scalar's text, unchanged) or `hole` (the expression of the lone `${{ }}` hole the text is; only on a `scalar: lone-hole` rule) |
| `insert-item` | the matched sequence | `value`, optional `at` |
| `add-key` | the matched mapping | `key`, `value` (a scalar, or a mapping of plain data) — refuses a key the mapping already holds |
| `remove-entry` | the matched mapping entry or sequence item | — |

No operation carries a path of its own; the matcher supplies the location. The model is JSON Patch's — a declarative edit as a short sequence of primitives over a document — but the names deliberately are not, because these are narrower: `move` relocates a value anywhere across parents and replaces an occupied destination, while `rename-key` only ever renames within one mapping and *refuses* an occupied destination.

A value `set-value` or `insert-item` writes must be a **scalar** — a string, number, boolean or `null`. The file applier renders one by re-quoting it in the author's own style at the node's own span, which has no meaning for a mapping or a sequence, so a structured value there is refused when the entry is *read*. Otherwise the limitation would be invisible until someone ran `telo migrate` and was told, permanently, to fix it by hand.

`add-key` is the one operation that may write a **mapping** — of plain data, with mappings, sequences and scalars beneath it. A new key owns its whole span, so nothing the author wrote is re-quoted: the file applier renders the mapping fresh, in the style of the mapping it joins — lines at the entry's column beneath a block mapping, inline before a flow mapping's closing brace — with each string written plain only when it is a bare word that reads back as that string. A sequence, or anything that is not plain data, is refused when the entry is read.

The vocabulary is closed on purpose. Every operation has a known YAML edit form, and that is what makes a migration applicable to a *file* at all — and what lets the driver derive whether a quick fix exists, read straight off the verb. **A migration whose operation does not fit is a signal to extend the operation set, never to hand-write a rewrite.**

### The matcher

**Containment is positive and required.** A rule states which document kinds it may touch (`inKind`) and which region of those documents it may reach into (`under`). Nothing outside is reachable.

`under` is **anchored at the document root**: it names top-level keys, and the match must be at or below one of them. Anchoring is what makes the containment claim true rather than decorative — a `Telo.Definition`'s `resources:` template body carries other kinds' configuration, so a rule that matched "any path segment spelled `schema`" would reach the very user JSON blob the positive form exists to keep out, and delete from it silently.

| key | required | meaning |
| --- | --- | --- |
| `key` | one of `key` / `scalar` | the mapping key this rule rewrites |
| `scalar` | one of `key` / `scalar` | an untagged string scalar (a mapping value or a sequence item, never a key) whose text has this shape: `lone-hole` or `interpolated`, read by the hole grammar every tag with holes shares |
| `inKind` | yes | document `kind:` values this rule may match in |
| `under` | yes | top-level document keys; the match must be at or below one of them |
| `value` / `valueOneOf` | no | the value must equal this / be one of these |
| `valuePattern` | no | the value must be a string that **fully** matches this pattern |
| `valueNotPattern` | no | the value must be a string that does **not** fully match this pattern |
| `withSibling` | no | a key that must be present in the same mapping |
| `notUnder` | no | narrows within `under` — e.g. the data-bearing JSON Schema keywords |
| `inSchema` | no | narrows to a JSON **schema region** — see below |
| `ancestor` | no | `{ path, key, value }`: the matched path ends in `path` (which ends at the matched key), and the mapping holding `path`'s first key holds `key` with the scalar `value` |
| `withoutKey` | no | the matched value must be a mapping that does not hold this key |

### Telling a spelling apart by its shape

`valuePattern` and `valueNotPattern` select a legacy value by its shape, where no list of known values could: the core entry `capability-as-extends` moves a module's kind written in `capability:` into `extends:`, and a module's kind is any `<Alias>.<Kind>` whose alias is not `Telo` — every lifecycle role is written `Telo.<Role>`. The two patterns are that test (`valuePattern: "[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*"`, `valueNotPattern: "Telo\\..*"`), with no name resolved. A pattern matches the whole value, so an entry never depends on whether its author anchored it, and a value that is not a string matches neither. They do not combine with `value` / `valueOneOf`, or with a `scalar` rule. The core entry `element-from-item-relative-pointer` is the other user: a bare field name at `x-telo-context-element-from-item` (`valuePattern: "[^/~]+"`) is qualified to the relative pointer naming that field beside the region, `0/<field>`, wherever a schema region holds it (`DEPRECATED_ELEMENT_FROM_ITEM_FIELD`).

A pattern is **evaluated as RE2**, by the same engine CEL's `matches` uses, in every runtime — no lookahead, no lookbehind, no backreference, and `.` matches every character but a line feed — and the entry reader refuses anything RE2 does not read. An entry travels to every runtime, and a pattern one regex dialect reads differently from another would make a manifest migrate on one kernel and not on another, silently. RE2's lack of lookahead is also why there are two tokens: "an alias other than `Telo`" is a lookahead in one pattern, and a positive pattern beside a negative one says it without one. Listing the excluded values instead would have rewritten a typo such as `Telo.Invokable` into an `extends:` and reported it as a missing parent; left alone, it reaches the roster's own refusal, which names the role meant.

### Placing a member by where it is written

A key name alone reaches every mapping that spells it: `code` is a member of a catch list's error binding and of countless other schemas. `ancestor` places a match by the structure around it instead — a fixed suffix of the path ending at the matched key, whose head sits in a mapping carrying a given key and value — and `withoutKey` leaves a node the current spelling already reached alone. The core entry `caught-member-marks` is the user: the `code` and `data` members of an `error` binding in an `x-telo-context` written beside `x-telo-outcome-list: catches` gain `x-telo-caught-member: code` / `data` (`add-key`), where they carry no mark (`DEPRECATED_IMPLICIT_CAUGHT_MEMBER`). A published `notFoundHandler.catches` that declares no context at all gains the `x-telo-context` of what `http-server` 0.39.1 binds there at run time — `request`, and `error` with `code`, `message` and `data`, marks included, and nothing that runtime does not bind (`problem`, `error.displayMessage`) — written by one `add-key` of a mapping, placed by `ancestor` (`properties` / `notFoundHandler` / `properties` / `catches` inside an object schema) and left alone by `withoutKey: x-telo-context` wherever a context is already written.

### The one region a kind list cannot name

An annotation keyword occurs in author-written JSON Schema, and schema fragments are not confined to kind documents: an inline `inputType:` / `outputType:` on **any** kind that declares one, an API route's `request.schema.body`, a `Telo.JsonSchema`'s `schema`. That set of kinds is open, and enumerating the standard library's would put resource-kind knowledge into the analyzer — against the topology-driven constraint, and incomplete the moment a third-party kind declares a schema-valued field.

So a rule may instead declare `inSchema: true`, bounding it to nodes reached through the **kernel's own** schema-valued keys (`schema`, `status`, `inputType`, `outputType`, `itemType`), which no kind owns. Containment is by ancestry rather than by root key, which is what reaches a route's request schema.

With `inSchema`, and **only** with it, `inKind` and `under` may be `["*"]` — and **only** for a rule whose `key` begins with `x-telo-`. Both conditions are refused when the entry is read. That pairing is the containment: the region bounds where the walk may go, and the reserved key bounds what it may touch, since an `x-telo-*` key is Telo vocabulary wherever it appears and cannot mean something else inside a resource's configuration. A module-shipped entry can therefore no more spell `"*"` than it can name another module's kind.

### The one spelling a key cannot name

The untagged `"…${{ }}…"` interpolation was a value of every field of every kind, so it is found by what the value IS rather than where it sits: `match.scalar` selects an untagged string scalar by its shape — `lone-hole` (one `${{ }}` hole, only whitespace around it) or `interpolated` (holes among text). A tagged scalar, `!literal` included, is never matched, and a `${{` no hole can be read out of matches neither. A **core** entry may pair `scalar` with `inKind` / `under` `["*"]`: that reach is exactly the strings the loader compiled as CEL before the tag existed, so the wildcard claims no more than the spelling already meant. A module entry may not. `key`, `value`, `valueOneOf` and `withSibling` are refused beside `scalar`; `notUnder` and `inSchema` still narrow it. The core entry `untagged-interpolation` is the one user: a lone hole becomes `!cel "<expr>"` (`set-tag` with `source: hole`), anything else `!interpolate` with its text unchanged.

The residue is stated rather than claimed away: a manifest that asserts *about* a schema — a schema literal under a key spelled `schema` inside an assertion's expected value — is reachable, and would be rewritten into its own synonym. That cannot be closed in a data-only matcher without naming kinds. It is accepted because the sites the wildcards reach are exactly the ones no enumeration covers, and the alternative leaves an author reading a deprecation `telo migrate` refuses to act on.

The alternative — walk the whole document and subtract — cannot be made sound, because the set to subtract is unbounded: a `Run.Value` value, an `Assert.Equals` expected, any kind whose config carries a user JSON blob can hold something shaped like the node a rule looks for, and forgetting one corrupts a manifest with no diagnostic. It also cannot express the guarantee the module surface is promised to carry — *a dependency can rename its own field and provably nothing else* — which is a statement about what a rule may **reach**, so it has to be said positively. `notUnder` remains for narrowing inside a region a rule legitimately reaches.

Matching against the *known* legacy values rather than any value matters for the same reason: an unrecognized value is left alone for the ordinary validator to report, instead of being silently rewritten.

Two further consequences hold for any rule:

- A rewrite that needs **alias scope** or **ref-slot knowledge** is not expressible, because the phase runs before the definition registry exists. Three candidate migrations were disqualified on exactly that ground.
- A migration that **cannot** rewrite leaves the node untouched — never guessing, never dropping. A malformed legacy value and a `rename-key` whose destination is occupied both qualify; the ordinary validator then reports the node with an accurate message rather than the migration repairing it into something the author did not write.

## What the driver guarantees

These are the driver's guarantees, not each entry's proof obligation — which matters once entries are aggregated from different parties, where "it happens to work" is not determinism:

- **One pass**, with the match set frozen against the pre-migration tree, so no rule can match a node another rule produced. Freezing alone is not enough for a **sequence index**, which is not an identity — a stale key path resolves to nothing and refuses itself, while a stale index would quietly name a different element — so a match into an array that an earlier patch resized is refused too.
- **Rules within an entry apply in order** at each match; a patch that cannot apply in full applies not at all.
- **Entries are independent** and never see one another's output.
- **Idempotency follows from the above**: a rule matches only the legacy spelling, so re-running finds nothing.
- **The phase runs before desugaring**, so a rule only ever matches author-written nodes. A synthetic import manifest has no YAML document to edit, would record a path the file never had, and shares its `variables` / `secrets` by reference with the module doc — so a match inside one would apply twice.

The phase is off for a round-trip view: the editor pairs manifests to YAML nodes by index and writes the pair back on save, and migrating one half of that pair would silently change your file. `telo migrate` is likewise a raw consumer — it has to see the legacy spelling to find it.

The file applier is stricter than the tree applier in one direction, and says so rather than hiding it. A rewrite the tree accepted may still be unwritable — a flow-style sequence has no item line to extend, a block scalar's span covers the newline that ended its mapping entry, removing a sequence item's *only* entry would leave a bare `- `, and a comment between an entry and its successor cannot be swallowed by the splice that removes the entry — and two patches whose byte spans overlap cannot both be spliced. `telo migrate` reports each such location instead of skipping it silently, because the diagnostic that sent you there says to run the command; those need a hand edit.

What is *not* unwritable is a mapping entry that opens a sequence item (`- type: string`, the shape a legacy `anyOf` branch takes). Removing it splices out to the following key, which slides onto the dash at the column it already occupies — the block-style case a whole-line removal cannot express, and the one the shipped entry meets most often.

## Library migrations

A library declares its migrations under `migrations:` on its `Telo.Library` document, beside the definitions they repair. A migration is data: no controller, no lifecycle, nothing created. Its **key is its diagnostic code** (`SQL_BEFORE_MIGRATIONS_RENAMED`), which names it in a consumer's diagnostic, in `telo migrate` and in a refusal. A `Telo.Application` has no `migrations:` key, since nobody imports it. A migration is not exported and not gated: it applies to every file whose import closure reaches the library, published dependencies included.

```yaml
kind: Telo.Library
metadata: { name: SQLite, version: 0.15.0 }
migrations:
  SQL_BEFORE_MIGRATIONS_RENAMED:
    reason: "`beforeMigrations:` is now `prepare:`; nothing re-runs, because the ledger stores the migration key alone."
    rules:
      - rewrite: Self.Schema
        match: { type: object, required: [beforeMigrations] }
        move: { /beforeMigrations: /prepare }
```

A consumer importing the library as `Db`, `Store` or `SQLite` gets the same warning on its own line, naming the library that declared it, and the same repair; `telo migrate` writes it back:

```text
telo.yaml:9:1  warning  `beforeMigrations:` is now `prepare:`; nothing re-runs, because the ledger stores the migration key alone.
declared by sqlite (oci://ghcr.io/telorun/sqlite@<version>)
run `telo migrate telo.yaml` to apply
SQL_BEFORE_MIGRATIONS_RENAMED
```

### Which nodes a rule reaches

- **`rewrite: Self.<Name>`** names one type of the library's own module: a kind, a named shape, or a kind the library no longer declares. Another library's type, or a re-exported one, is refused — a type has one owner, who knows its history.
- A kind's rules reach every declaration of it: top-level documents, inline declarations at slots and at an import's `resources:`, template-body entries, `with:` members and the branches of `!if` / `!switch` / `!for-each`. A shape's rules reach every value at a position a current kind schema types by that shape. A rule also reaches the positions the current schema no longer types inside a value of the library's own types, so a map there whose `kind:` names an own type is migrated; payload held by an open schema is never scanned.
- A rule reaches only its own module's types. A foreign declaration inside a matched node can be moved or copied, never read or changed.
- A kind-only declaration — a library's `resources:` entry or `needs:` entry naming a kind the library no longer declares — is retyped to that kind's replacement: the kind the rules of the removed kind write at the declaration's root, followed onward while it is itself removed. It is kept, and how the new kind fits the library's body is judged by the library's own analysis. A replacement that is not exactly one declared kind leaves the entry as written with `MIGRATION_FAILED`.

### `match`: telling the legacy spelling apart

`match` is a closed vocabulary read as data: `type`, `required`, `const`, `enum`, and `properties` / `items` holding the same vocabulary, with `<key>: false` under `properties` meaning the key is absent. Anything else — `anyOf`, `$ref`, `x-telo-ref` — is `SCHEMA_VIOLATION` at the library. A tagged value (`!cel`, `!ref`, …) never satisfies `type`, `const` or `enum`, and does satisfy `required`.

A rule fires only where its `match` holds, and the library's own `telo check` proves the `match` disjoint from the current schema (`MIGRATION_MATCH_OVERLAPS_SCHEMA` otherwise: require a key, or pin a `const` / `enum`, the current schema refuses). That proof is what makes migrations idempotent without version stamps.

### The change

A rule writes only what changes; everything it does not mention is kept as written, tags, choices (`!if`, `!switch`, `!for-each`) and foreign content included.

- **`remove`**, **`move`** and **`copy`** are positional operations over JSON pointers into the matched node. `move: { /href: /to/href }` takes a value from one place to another; `copy` leaves the source. A destination follows JSON Patch `add`: a member is set, an index inserts, `-` appends, missing containers are created. A missing source writes nothing, so a key can be conditional.
- **`set`** holds literal data only; a tag in it is `SCHEMA_VIOLATION`. A computed value reaches a new position by being moved or copied, never written.
- A `kind:` in `set:` is written library-relative (`Self.Navigate`) and spelled in the consumer's alias (`U.Navigate`). At the declaration's root it renames the kind and keeps `metadata`, so the name and every reference to it survive. This is how a library renames a kind at its declarations; a kind named in another library's definition (`extends:`, an `x-telo-ref` kind) is renamed by deprecating the old kind with `replacedBy` for a release, then removing it.
- A rule whose result still satisfies its own `match`, two writes reaching one position, or a move onto a position the node already holds is `MIGRATION_FAILED` at the consumer, naming the cause; the node is left as written.

### Reading other nodes: `resolve`

A rule can bind a declaration its node places, at a pointer into the node (inline or by `!ref`): `resolve: { data: { at: /data } }`. A bound declaration is read in one of two ways:

- **As migrated** (no `before`): it is read in its current spelling, typed by its kind's current schema.
- **As it was** (`before: Self.<Type>`): it is read as it was before this migration's rule of that type rewrote it, typed by that rule's `match`. This is how a node that places a declaration takes over the fields the declaration's own rewrite drops.

`copy: { data#/loading: /loading/0 }` then reads from the binding. Bindings are declared, never written in values, and a rule never moves *from* a binding.

**The hand-over rule.** The first rule of a type that another rule of the same migration reads with `before` is its hand-over rule; later rules of the type are its fallbacks. A referent is a declaration other nodes place by `!ref`, and its **members** are every `!ref` in its module instance that resolves to it — at a reference slot or not, own or foreign kind, a `targets:` entry, a step `invoke:`, a `with:` slot, an import's supply, plus every `exports.resources` entry naming it. The hand-over rule fires on the referent only when it has at least one member, every member position is the `at` of a `before` binding in a rule that fired and converged on the node holding it, and every rewritten node passes the current schema; the group is committed whole. Otherwise — a member that no rule can sit at (a foreign slot, an export, an import's supply), or no member at all — the referent takes the fallback rule, the readers see no hand-over, and every node placing it is left as written and still current. With no fallback the referent stays as written and reports `MIGRATION_FAILED` naming the position that kept the hand-over from firing. A CEL read of `resources.<referent>` is not a member.

**Content never crosses a module-instance boundary.** A library supplied the referent, or an importer of an exported one, keeps placing it whole, so the fallback keeps the content on the referent; every module's result depends on its own source and its libraries' types alone, and an application and the library it supplies migrate to the same files in either order. A migration never creates a top-level document or changes another document.

### Chains, order and failure

A consumer several releases behind needs several migrations on one node. Each node is brought to a fixpoint: the first rule (ordered by migration code, then position) whose type and `match` hold for the node's current value and that has not fired on it applies, each rule fires at most once per node, and a leftover match when none applies is `MIGRATION_FAILED` (a cycle). A node reports one diagnostic per migration that fired, with the migration's `severity` (`info`, `hint`, `warning`).

Any failure leaves the node untouched and reports `MIGRATION_FAILED` at the node — at the `imports:` entry for a dependency's file — naming the migration and the cause; the kernel raises `ERR_MIGRATION_FAILED` at load. Findings of the current schema under that node are held back.

The stage runs over the whole loaded graph, once every import has loaded and before any analysis, on every host including the browser. The Rust build refuses an `imports:` entry reaching a library that declares `migrations:` where a rule could apply (`ERR_UNSUPPORTED_MANIFEST_FEATURE`); a manifest in current spelling still checks and runs there.

### Removed types and shapes

A `rewrite:` naming a type the library no longer declares is valid only for a removed **kind**, provided some rule of the library rewriting it writes `kind:` at its root (`MIGRATION_TYPE_UNKNOWN` otherwise). A removed **shape** is never a target: a shape value carries no name. To migrate a value whose shape was removed or replaced, write a rule of the type that holds that position now — the current shape there, or the nearest own kind or shape enclosing it.

### Checks at the library

`telo check` of the library refuses a migration that cannot be trusted; a consumer sees these through its dependency verdict, and the kernel never runs them:

- `MIGRATION_MATCH_OVERLAPS_SCHEMA` — the `match` is not proved disjoint from the current schema.
- `MIGRATION_KIND_FOREIGN` — a `kind:` in `set:` names a kind the library neither declares, re-exports, nor removed.
- `MIGRATION_TYPE_UNKNOWN` — `rewrite:` names a type that is neither declared nor a removed kind.
- `MIGRATION_BINDING_INVALID` — a `resolve` `at` names no reference slot or required key, a `before` names a type no rule of the migration rewrites, a `copy:` source names no binding or a `move:` source names one.

`set:` is not judged against the current schema at the library: a migration is written against the vocabulary of its own release, and the converged result is validated at each consumer.

### Proving a migration

A rule's result is not proved at the library; a fixture is. Keep one legacy-spelling manifest per migration in `tests/__fixtures__/manifest-migrations/<code in kebab case>/` and assert it from `tests/manifest-migrations.yaml` with `Assert.Manifest`, expecting that migration's diagnostic, those of the migrations chained after it, and nothing else; add `runs: true` where the fixture can boot. Import the library under an alias other than its own name, so the fixture shows the migration reaching any alias.

```yaml
kind: Assert.Manifest
metadata: { name: sqlBeforeMigrationsRenamed }
source: ./__fixtures__/manifest-migrations/sql-before-migrations-renamed/telo.yaml
expect:
  warnings: [{ code: SQL_BEFORE_MIGRATIONS_RENAMED }]
  runs: true
```

### Renaming a kind, and retiring a migration

Rename a kind by declaring the new one, deleting the old declaration and adding a migration whose rule is `rewrite: Self.<OldName>` with `set: { kind: Self.<NewName> }`. A migration carries no version stamp: a consumer's import pin is not the version its file was written against, and a published dependency must be rewritten whatever it pinned. Deleting a migration is therefore a **breaking removal** — a published dependent still in the old spelling stops loading — so retire one only when the library's dependents on the hub no longer carry the spelling, and release it as a breaking change (an `Added` fragment describing the break; breaking changes ship as minors).

## Retiring a core migration

An entry carries **no version stamp**. "Can this be deleted?" turns on whether any published artifact still carries the legacy spelling, which the artifact's own release version cannot answer — the hub can, since it caches every tracked module version's `telo.yaml`. A stamp would record when an entry was written, which git already does, while looking like an answer to a question it does not address.

Retiring a migration is deleting its file.
