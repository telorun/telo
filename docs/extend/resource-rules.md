---
sidebar_label: Resource Rules
slug: /extend/resource-rules
description: "Let a kind declare, as a CEL condition, how the fields of one resource must relate to each other — an index naming a real column, a foreign key whose sides agree — so telo check reports it before boot."
---

# Resource rules

A kind's schema says a great deal about one field — its type, its shape, which
resource it may reference, what its value means. It says nothing about how one
field relates to **another field of the same resource**. An index naming a column
its table does not declare, a foreign key whose two sides differ in length, a
`renamedFrom:` pointing at a column the table still declares: each is decidable
by reading the YAML, and each used to fail only at boot.

`x-telo-resource-rules` is how a kind declares those relationships, as data, so
`telo check` reports them — in CI, in the editor, and on a laptop with no
database.

For a requirement on the resource that *references* this one — a docs renderer
needing its server to collect an OpenAPI document — see
[Referrer rules](./referrer-rules.md).

## Writing a rule

The annotation goes inside the kind's `schema:` block, beside the properties it
talks about:

```yaml
kind: Telo.Definition
metadata:
  name: Table
capability: Telo.Provider
schema:
  type: object
  properties:
    columns: { type: object, additionalProperties: { type: object } }
    indexes: { type: array, items: { type: object } }
  x-telo-resource-rules:
    - in: /indexes
      condition: !cel "this.columns.all(c, c in self.columns)"
      code: SQL_INDEX_UNKNOWN_COLUMN
      message: names a column this table does not declare.
```

| Field | Meaning |
| --- | --- |
| `condition` | CEL, **TRUE when the rule holds**. Required. |
| `code` | Names the rule. Reported in the diagnostic's `data.rule`. Required, unique within the kind. |
| `message` | What the relationship means, written by the kind's author. Required. |
| `in` | JSON Pointer to the collection to iterate, with `*` and repeated groups to name several. Optional. |
| `reachable` | `{ kind, use, through }`: iterate the declarations references of `kind` name, found by a walk through other resources. Optional, and exclusive with `in`. |
| `severity` | `error` (default) or `warning`. |

### `in:` is the anchor

With `in:`, the rule runs once per element and the diagnostic is anchored at that
element — `indexes[1]`, `columns.email`. Without it, the rule runs once and
reports at the resource, which is what a discouraged-value warning wants:

```yaml
    - condition: !cel "!has(self.reclaim) || (type(dyn(self.reclaim.afterDuration)) == string ? !string(dyn(self.reclaim.afterDuration)).matches('^[+-]?(0|([0.]+(ns|us|µs|μs|ms|s|m|h|d|w))+)$') : dyn(self.reclaim.afterDuration) != 0)"
      code: SQL_RECLAIM_DURATION_DISABLED
      severity: warning
      message: sets reclaim.afterDuration to 0ms, switching off the time backstop.
```

`in:` may name more than one collection. `*` is every item of a list or value
of a map, and a group of steps followed by `)*` repeats zero or more times —
the repeated-group form of the eval-path grammar, spelled as pointer segments,
with `|` between alternatives. A navigation tree whose groups hold more
entries is visited at every depth by one rule:

```yaml
    - in: /navigation/items(/*/items)*
      condition: !cel "this.type != 'page' || self.pages.exists(p, p.name == this.page.name)"
```

The rule runs once per entry of `navigation.items`, then of each entry's
`items`, and so on; a violation is anchored at the entry itself
(`navigation.items[1].items[0].items[2]`). `telo check` follows the pointer
through the kind's schema — local and named shapes, union branches — and
refuses a group that reaches nothing from where it is written. A key holding
`(`, `)` or `|` cannot be named.

Iterating what the pointer names is what makes a reported path exist. A rule
cannot instead return a set of offenders: the pointer and the offenders would be
two independent claims, and a rule anchored `/indexes` while filtering
`self.columns` would emit diagnostics at paths that do not exist.

### What is in scope

| Name | Is |
| --- | --- |
| `self` | the whole resource |
| `this` | the element `in:` iterates — an array item, or a map entry's **value** — or, with `reachable:`, each declaration the walk finds |
| `key` | the map key, when the collection is a map (`null` for an array) |
| `coReferrers` | *(with `coReferrers:`)* the other resources this rule judges whose slot names the declaration mine names |

`self` stays in scope inside the loop, which is how a rule correlates an element
against the whole (`c in self.columns`) with no path language. Correlating an
element against *itself* is just a closure:

```yaml
    - in: /foreignKeys
      condition: !cel "size(this.columns) == size(this.references.columns)"
```

### Reading what a reference names: `resolve:`

A rule sees the resource as written, so a reference slot holds a reference, not
the resource it names. A rule that needs the referenced declaration's fields opts
in with `resolve:`, a list of JSON Pointers to this kind's own reference slots.
Inside the condition each one reads as the declaration it names, one level deep:
a single slot becomes that declaration, and a collection of references becomes
the same collection with each entry resolved.

```yaml
    - resolve: [/languages]
      in: /languages
      condition: !cel "size(self.languages.filter(o, o.code == this.code)) == 1"
      code: LANGUAGE_CODE_DUPLICATE
      message: lists two language models under the same code.
```

The resolution is the one a referrer rule's `peers:` uses: the kind's reference
slots decide what is a reference, an alias-qualified reference resolves through
its import, and references inside a resolved declaration stay references. When
any reference cannot be resolved — a declaration this analysis does not hold, or
a library's `resources:` input, known only by its kind until the importer
supplies it — the rule does not run on that resource, and the skip is reported
(`RESOURCE_RULE_SKIPPED`) rather than evaluated over a partial set. A
`!module-path` in a resolved declaration compares as the path its author wrote.

**A pointer may continue past a reference** into the declaration it names, a
hop at a time, and `*` ranges over every item of a list or value of a map — the
location grammar of `x-telo-value-schema-from` — including a collection whose
entries hold a reference deeper down (`/table/foreignKeys/*/references/table`
reads the table each foreign key names). A form's rule reading the model
behind each field's option source writes:

```yaml
    - resolve: [/fields/*/options/model]
      in: /fields
      condition: !cel "type(this) == string || has(this.options.model.schema)"
```

Each hop resolves as the first does, in the scope of the declaration holding the
reference: a hop out of a declaration another module wrote reads that module's
own names and imports, so it reaches a declaration the module keeps to itself
as well as one it exports. A hop that cannot be resolved skips the rule as
above. `telo check`
follows a pointer past a slot into every kind the slot may hold, and refuses one
that names nothing in any of them (`RESOURCE_RULE_INVALID`).

A pointer may repeat a group as `in:` does — `/navigation/items(/*/items)*/*/page` reads the page every entry names, however deep its group. The group is taken as many times as the resource's own data holds another level; it repeats over the resource's own fields only, so a group stepping over a reference slot is refused (`RESOURCE_RULE_INVALID`).

**A pointer that resolves to nothing contributes nothing.** An optional field a
resource leaves out stays *absent* in what the rule reads — never a key that
exists and holds nothing — so `self.?relationships.orValue([])` on a store
declaring no relationships yields the empty list the author guarded for. That is
the line `in:` and a referrer rule's `peers:` already draw ("an absent collection
is an empty one"), and all three subject views agree on it.

**A rule is not evaluated over a declaration the slot refuses.** When a reference
names a resource of a kind its slot does not accept, the resource is already
refused at that very slot (`REFERENCE_KIND_MISMATCH`) and the condition would
read fields off a shape it was never shown — so the rule does not run and
**nothing is reported about it**, not even a skip. Coverage did not vary
invisibly here: a second diagnostic about the rule's internals would blame the
kind's author for the manifest author's mistake.

It is opt-in so that no existing rule changes what it reads.

**A bound declaration is equal only to itself.** `==`, `!=` and `in` decide a
declaration a rule bound — `self`, a declaration `resolve:` or `coReferrers:`
binds, `this` under `reachable:` — by which declaration it is (the module that
declares it and its name), never by what it holds. So
`self.languages.exists(l, l == self.primary)` runs over models whose fields hold
expressions, a declaration reached through an import alias equals the same one
reached by its bare name, and two declarations holding the same fields are
unequal. A written entry holding declarations (`{ mount, prefix }`) compares its
declarations by identity and its other members by value. Read whole any other way
— handed to a function, `size(l)`, `string(l)` — a declaration is read with
everything it holds, and an expression in it skips the rule.

### Others claiming the same target: `coReferrers:`

Some conflicts exist only between two resources of one kind that share what they
reference: two session sets with one `name` on one store write the same records,
while the same name on two stores never meets. A rule over one resource cannot see
the other, and a [referrer rule](./referrer-rules.md#coreferrers--the-others-reaching-me-through-the-same-slot)
must be declared on the referenced kind — the store — which another module owns
and which must not name its consumers. `coReferrers:` lets the claimant declare it:

```yaml
x-telo-resource-rules:
  - coReferrers: /store
    condition: !cel "!coReferrers.exists(o, o.name == self.name)"
    code: SESSION_NAME_DUPLICATE
    message: claims a name another session set on this store already claims.
```

`coReferrers:` is a JSON Pointer to ONE reference slot of this kind. `coReferrers`
binds every other resource, anywhere in the analysis, of this kind or of a
descendant that inherits its rules, whose slot at that pointer resolves to the same
declaration mine does. Each binds as written with its references resolved one
level — the binding `peers:` and a referrer rule's `coReferrers:` use — so
`o.store` is the store's declaration. The rule still runs once per resource (or
per `in:` element); an empty set is the ordinary case and a pass. A `base:` child
inherits no rule, so it joins no set; the controller's runtime guard covers it.

When my own slot names nothing the analysis can compare — a library's
`resources:` input known only by its kind, a reference naming nothing loaded, an
expression — the binding is a mark, and the rule is `RESOURCE_RULE_SKIPPED`
wherever the condition reads `coReferrers`; a co-referrer's own unresolved member
or expression skips it only where the condition reads that member. A pointer
naming a plain field or a collection of references is `RESOURCE_RULE_INVALID` at
the kind. Every set is built once per kind, slot and target, so the cost stays
linear in the resources the analysis holds.

An analyzer released before `coReferrers:` evaluates the condition with the name
unbound and reports a defect against the module that wrote it, so that module
declares a `requires: telo:` floor at the release that carries the binding.

### Every reference reachable: `reachable:`

Some relations are not between a resource's own fields but between the resource
and everything it reaches: a site listing its pages wants every link, menu entry
and redirect anywhere beneath it to name one of them, whether it is written in
the site, in a layout the site holds, or in a component a library supplies.
`reachable:` finds them:

```yaml
x-telo-resource-rules:
  - resolve: [/pages]
    reachable: { kind: Ui.Page, use: schema, through: [dependency, call] }
    condition: !cel "self.pages.exists(p, p == this)"
    code: PAGE_UNLISTED
    message: names a page the site does not list.
```

| Key | Meaning |
| --- | --- |
| `kind` | The kind of reference to find, alias-qualified as in `x-telo-ref`; a descendant kind counts. |
| `use` | The use of the slot it is found at. |
| `through` | The uses of the slots the walk crosses, at least one. |

From the resource, the walk crosses every reference slot whose use is in
`through` into the declaration it names — a top-level one, an inline one, one an
imported library declares — and on from there. A step's `invoke:` target, at any
depth of any step body (branches, loops, `catch:` and `finally:` included), is a
slot of use `call`. Every reference of `kind` at a slot of use `use` along the
way is a subject, and `this` is the declaration it names, compared by identity
(above), so a library's page listed through its import alias is never reported as
unlisted. A slot whose use is in both is crossed and judged. Each declaration is
walked once, so a cycle ends and the cost stays linear in what the walk reaches.

A finding is reported at the reference when the entry's own modules wrote it.
One written in a dependency is reported at the slot of the entry's own modules
where the walk first entered that dependency, and its message names the
declaration reached and the reference entered through:
`Site/site: names a page the site does not list. (the Ui.Page Docs.orphan, reached through Docs.nav)`.

A hop the walk cannot cross — a reference naming nothing loaded, a library's
kind-only `resources:` input, an expression where a reference belongs — makes the
rule `RESOURCE_RULE_SKIPPED` for that resource, rather than judging part of what
it reaches. A rule whose walk reaches nothing on any resource of its kind is
`RESOURCE_RULE_UNEXERCISED`. `resolve:` and `coReferrers:` still bind `self`
beside it.

### Polarity

`condition` is true when the rule **holds** — the same polarity as
`Telo.JsonSchema.rules`, whose vocabulary this borrows. Two CEL rule
vocabularies with opposite polarity is a trap an author falls into once per
rule, so they match. Write the `message` as the violation anyway; that is what
`Telo.JsonSchema` does, and the diagnostic reads as the kind's name plus your
sentence.

## Restrictions

Checked at `telo check` on the **kind**, so a bad rule is caught where it is
written rather than on somebody's manifest:

- **No host-backed functions.** `sha256`, `md5`, `sha1`, `sha512`, `hmac`,
  `base64Encode`, `base64Decode` and `json` are supplied by the kernel at boot
  (they need Node `crypto` / `Buffer`, which the analyzer must not import). The
  analyzer registers throwing stubs, so a rule calling one could never run.
- **No non-deterministic functions.** `nowIso`, `uuidv4` and friends evaluate
  fine and would make a verdict depend on when it ran.
- **`in:` must name a collection this kind declares** — otherwise the anchor
  points at nothing.
- **Each `resolve:` pointer must name a field this kind declares** — or, past a
  reference slot, a field a kind the slot may hold declares.
- **`coReferrers:` must name one reference slot this kind declares** — a plain
  field or a collection reaches no other resource.
- **`reachable:` iterates instead of `in:`, never beside it**, its `kind` must
  name a kind, its `use` must be one of `schema`, `dependency`, `call`,
  `detached`, `trigger.inbound`, `trigger.consumer`, and its `through` must name
  at least one use from the same list.
- **The condition must parse and type-check.** One expression, one verdict: the
  templating engine's.
- **`condition:` must carry the `!cel` tag.** The reader is lenient and a bare
  string still runs, but untagged the expression is not CEL to the editor's
  colouring, completion or hover — so a rule silently stops being CEL to every
  surface but evaluation, which is the failure a strict half exists to move
  earlier.

A rule is skipped when a value it reads holds a `!cel` or an `!include-*` embed —
the comparison would run against a placeholder — and the skip names the tag it
found and the value that holds it (`self.routes[1].path`).

An [accessor field](./accessor-fields.md) is not such a value: it is never
evaluated, so a rule reads it as the binding the controller receives —
`{ root: "row", path: ["id"] }` for `!cel "row.id"`, `{ value: 5 }` for a
literal `5` — on the resource itself, on every declaration `resolve:` binds and
on an inline declaration beneath either. A condition tells the two apart with
`has(this.sort.root)`. An accessor field holding anything but a plain chain or a
literal is already `ACCESSOR_NOT_PLAIN_CHAIN`; it reads as `{ value: … }` with
the expression still inside, so a rule reading that value is skipped.

What a condition reads follows a comprehension's variable. In
`self.routes.all(r, r.path.startsWith("/"))` the rule reads each route's `path`
and nothing else of a route, so a route whose `handler:` or `inputs:` holds an
expression is still judged; only a `path` that is itself an expression skips
the rule. A variable used bare (`size(r)`, `r in self.names`) reads the whole
element, and so does any other use of the collection (`size(self.routes)`). A **`!ref` is not one of them**: it names a declaration, which is a value
a rule compares perfectly well.

A presence test reads no value. `has(self.port)` reads only which keys `self`
holds, so `!has(self.port)` runs when `port: !cel "ports.http"` is written, and
`self.mounts.exists(m, has(m.hostnames))` runs over mounts whose `hostnames`
hold references. Only the owner of the tested member is read: when `self.listen`
is itself an expression, `has(self.listen.port)` is skipped. The same holds in a
[referrer rule](./referrer-rules.md).

## Guard your optional fields

An unguarded missing key **throws** rather than yielding false, and a throwing
rule is reported as a defect in the rule — never as a violation of the manifest
it ran against, and **once per rule for the whole analysis** (see *Where a
failure lands*). Two spellings work:

```yaml
condition: !cel "!('renamedFrom' in this) || !(this.renamedFrom in self.columns)"
condition: !cel "!(this.?renamedFrom.orValue('') in self.columns)"
```

`has()` does **not** work under an iterated key: `has(self.columns[c].x)` is
`has() invalid argument`, because the macro needs a literal field selection. Use
`in` or optional chaining.

## When a rule does not run

Coverage that varies invisibly reads as passing, so both ways it can vary are
reported:

- **`RESOURCE_RULE_SKIPPED`** — a value the condition reads holds a `!cel`
  expression, which is not known until the resource is created. Skipped **per
  element**, and only when a node the condition actually *reads* is dynamic: an
  unrelated `version: !cel "module.version"` elsewhere on the resource does not
  disable the rule, and neither does an expression in a field of a list entry
  when the condition reads another field of it through a comprehension.
- **`RESOURCE_RULE_UNEXERCISED`** — the `in:` collection was empty, or the
  `reachable:` walk found nothing, on every resource of the kind in this
  workspace, so nothing proved the condition. Worth
  knowing, because cel-js types `self` only shallowly: a typo below the first
  level survives declaration validation and is caught only by evaluation.

## Diagnostics

| Code | Severity | Means |
| --- | --- | --- |
| `RESOURCE_RULE_VIOLATED` | the rule's `severity` | a resource broke the rule; `data.rule` names it, `data.path` anchors it |
| `RESOURCE_RULE_INVALID` | error for a malformed declaration, and for an evaluation failure in a rule this workspace declares; warning for an evaluation failure in a dependency's | the rule itself is malformed, throws, or exceeded its budget |
| `RESOURCE_RULE_SKIPPED` | information | the rule could not run here: a value it reads is not known until creation, or a reference it reads through — `resolve:`, the `coReferrers:` slot, or a hop of the `reachable:` walk — names nothing it can compare |
| `RESOURCE_RULE_UNEXERCISED` | information | the rule never ran anywhere |

Every violation reports under the one `RESOURCE_RULE_VIOLATED` code, with your
`code` in `data.rule`. Diagnostic codes are analyzer-owned and surfaces branch on
them, so a module contributing arbitrary ones could shadow machinery that never
expected a third party there. `data.rule` keeps a violation nameable and
greppable without entering that space.

## Where a failure lands

A rule that **throws** or **exhausts its budget** is a defect in the rule, found
while checking someone else's data. It is reported **once per rule per analysis**
— not once per resource the rule met — anchored where the reader can act on it,
and its severity follows from whether that reader can fix it:

- a **warning** at the `imports:` entry that brought the declaring kind in, when
  that kind belongs to a dependency: the consumer cannot change the rule, so an
  error would block `telo check` on a line they do not own;
- an **error** at the rule's own declaration
  (`schema.x-telo-resource-rules[<n>]`), when the kind is one of this
  workspace's own modules: here the reader *is* the author, and a declared rule
  that cannot run is checking nothing.

The message names the first resource the failure was seen at, as the example. Per
site, one upstream defect produced 107 diagnostics across 99 lines, every one
pointing at a line the reader does not own and cannot fix: a count that grows
with the consumer's manifest size for a single defect somewhere else is noise,
not an actionable error.

## Budget

A rule gets 50 ms per resource. Beyond it, evaluation stops and the rule is
reported as defective — a dependency's quadratic rule must not hang a consumer's
`telo check` or the editor's keystroke-time analysis. The ceiling bounds the
subject loop, not one expression: cel-js offers no step limit, so a single
pathological expression over one huge element still runs to completion.

## Inheritance

An `extends` child without `base:` is judged by its ancestors' rules and its
own, joined along the chain with the ancestors' first: a child adds rules and
never removes one, as a subtype's invariant is its parent's conjoined with its
own. `Sql.Schema` declares the reclaim warning once and every backend's `Schema`
kind gets it, whatever rules that kind declares beside it.

A rule's `code` is unique along the chain, so a child declaring a rule under a
code it inherits is `RESOURCE_RULE_INVALID` at the child's `code`, and the
inherited rule still runs as declared. Each rule is judged as the rule of the
kind that declared it: its module calls resolve in that kind's module, and a
rule that throws is reported at that kind's declaration.

A child with `base:` inherits no rule: its author schema is its own, and the
parent's rules guard the configuration the mapping builds through the parent's
controller.

## Keep the runtime guard

A rule moves a failure earlier; it does not replace the controller's check. A
library caller reaching a module's own entry point directly never passed through
`telo check`, so the controller stays the last line.
