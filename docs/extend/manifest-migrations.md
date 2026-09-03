---
sidebar_label: Manifest Migrations
slug: /extend/manifest-migrations
description: "How a renamed keyword or annotation keeps loading: migrations rewrite a legacy spelling to the current one at load, report it in your own files, and telo migrate writes the repair back to disk."
---

# Manifest migrations

Telo occasionally renames something a manifest can say — a schema annotation, a keyword, a value grammar. Published artifacts carry the old spelling and cannot be edited, so a rename can never simply *replace* the old form.

A **migration** is how that rename ships. It is a matcher plus a patch: the loader finds every occurrence of the legacy spelling and rewrites it to the current one, in memory, before anything else reads the manifest. The old form and the new one then behave identically, on every kernel, for every artifact ever published.

This is deliberately not the same mechanism as a **normalization** — desugaring an `imports:` map, extracting an inline resource, resolving a `!ref` sentinel. Those fold authoring sugar into an internal form, are never written back to source and are correctly invisible. A migration is author-visible: it reports what it rewrote and offers a way to make the file say it.

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

## Writing one

**A migration entry is one JSON file under `analyzer/migrations/`.** The set is read as one lexically ordered list, so adding a migration is one file and retiring one is deleting it — nothing lists the entries by hand. The files sit beside the language implementations rather than inside any one of them, because every kernel must apply the identical rewrite: a rewrite described twice, in two languages, is the divergence this design exists to prevent, and it would be invisible, since a migration that succeeds is silent. Only the Node half reads them today — the Rust reader is planned, and until it lands the Rust kernel applies no migration at all, so a legacy spelling fails there rather than being rewritten differently.

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
| `set-tag` | the matched scalar | `tag` (the engine name, no `!`) |
| `insert-item` | the matched sequence | `value`, optional `at` |
| `remove-entry` | the matched mapping entry or sequence item | — |

No operation carries a path of its own; the matcher supplies the location. The model is JSON Patch's — a declarative edit as a short sequence of primitives over a document — but the names deliberately are not, because these are narrower: `move` relocates a value anywhere across parents and replaces an occupied destination, while `rename-key` only ever renames within one mapping and *refuses* an occupied destination.

A written `value` must be a **scalar** — a string, number, boolean or `null`. The file applier renders one by re-quoting it in the author's own style at the node's own span, which has no meaning for a mapping or a sequence, so a structured value is refused when the entry is *read*. Otherwise the limitation would be invisible until someone ran `telo migrate` and was told, permanently, to fix it by hand.

The vocabulary is closed on purpose. Every operation has a known YAML edit form, and that is what makes a migration applicable to a *file* at all — and what lets the driver derive whether a quick fix exists, read straight off the verb. **A migration whose operation does not fit is a signal to extend the operation set, never to hand-write a rewrite.**

### The matcher

**Containment is positive and required.** A rule states which document kinds it may touch (`inKind`) and which region of those documents it may reach into (`under`). Nothing outside is reachable.

`under` is **anchored at the document root**: it names top-level keys, and the match must be at or below one of them. Anchoring is what makes the containment claim true rather than decorative — a `Telo.Definition`'s `resources:` template body carries other kinds' configuration, so a rule that matched "any path segment spelled `schema`" would reach the very user JSON blob the positive form exists to keep out, and delete from it silently.

| key | required | meaning |
| --- | --- | --- |
| `key` | yes | the mapping key this rule rewrites |
| `inKind` | yes | document `kind:` values this rule may match in |
| `under` | yes | top-level document keys; the match must be at or below one of them |
| `value` / `valueOneOf` | no | the value must equal this / be one of these |
| `withSibling` | no | a key that must be present in the same mapping |
| `notUnder` | no | narrows within `under` — e.g. the data-bearing JSON Schema keywords |
| `inSchema` | no | narrows to a JSON **schema region** — see below |

### The one region a kind list cannot name

An annotation keyword occurs in author-written JSON Schema, and schema fragments are not confined to kind documents: an inline `inputType:` / `outputType:` on **any** kind that declares one, an API route's `request.schema.body`, a `Telo.JsonSchema`'s `schema`. That set of kinds is open, and enumerating the standard library's would put resource-kind knowledge into the analyzer — against the topology-driven constraint, and incomplete the moment a third-party kind declares a schema-valued field.

So a rule may instead declare `inSchema: true`, bounding it to nodes reached through the **kernel's own** schema-valued keys (`schema`, `status`, `inputType`, `outputType`, `itemType`), which no kind owns. Containment is by ancestry rather than by root key, which is what reaches a route's request schema.

With `inSchema`, and **only** with it, `inKind` and `under` may be `["*"]` — and **only** for a rule whose `key` begins with `x-telo-`. Both conditions are refused when the entry is read. That pairing is the containment: the region bounds where the walk may go, and the reserved key bounds what it may touch, since an `x-telo-*` key is Telo vocabulary wherever it appears and cannot mean something else inside a resource's configuration. A module-shipped entry can therefore no more spell `"*"` than it can name another module's kind.

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

## Module-authored migrations

A module author has the same problem one boundary out: renaming a field on a kind they own breaks every consumer manifest written against the old name.

The mechanism is the same one — an entry of the same shape, travelling in the module's artifact, collected by one driver that cares about neither source. What differs is **scope of match and provenance**: a core entry may name any `inKind`, while a module's may name only kinds that module owns.

That is why containment is positive and required today, before the surface exists. The guarantee a consumer needs — *a dependency can rename its own field in your manifest and provably nothing else* — is a statement about what a rule may **reach**, and a rule that says where it may reach can be checked against what its module owns. A rule that only said where it may *not* reach could not be checked at all. Adding the anchor after third-party entries exist and the grammar is frozen would be far more expensive than requiring it now.

That surface is planned separately and is not built yet.

## Retirement

An entry carries **no version stamp**. "Can this be deleted?" turns on whether any published artifact still carries the legacy spelling, which the artifact's own release version cannot answer — the hub can, since it caches every tracked module version's `telo.yaml`. A stamp would record when an entry was written, which git already does, while looking like an answer to a question it does not address.

Retiring a migration is deleting its file.
