# Template expansion — `!for-each`, `!if`, `!switch`, configurations, and what is built on them

## Problem

Before: a template body declares a fixed list of literal entries, and every
entry is created when the instance initializes. A manifest likewise creates
every resource it declares and requires every input that has no `default:`.
None of these can be expressed:

- **N things from a list.** A blueprint can hand a consumer's list to ONE entry
  that already takes a list (`Http.Api` `routes:`, `Ai.Tools` `tools:`), but
  cannot turn a list into N resources, N map entries, N steps, or several items
  per element. Blocked: ScheduledJobs (a map of jobs becomes N
  `Scheduler.Cron`), routes from a list (N routes in one `Http.Api`), a CRUD
  application over several declared tables, a webhook receiver over several
  providers.
- **Presence and choice decided by configuration.** A kind with `port` and
  `adminPort` cannot run one server with two mounts when they are equal and two
  servers when they differ; a field cannot be present only when an input is.
- **One application, several backends, chosen by the environment.** An app
  cannot start on SQLite or PostgreSQL, or on OpenAI or Anthropic, depending on
  what its environment supplies: declaring both connections creates both, and
  declaring both API keys requires both.
- **A library cannot default an instance its importer may omit**: every
  `resources:` input is required at every import. And a library that borrows
  a collector while exporting a member of it deadlocks at init with nothing
  reported before boot.
- **A `with:` scope member is never checked.** Members of an `x-telo-scope`
  field get no per-resource pass, so a misspelled field, an unresolved `!ref`
  or a CEL typo inside `with:` passes `telo check` and fails when the scope
  opens.
- **CRUD's link to its table is a string nothing checks**, so a model property
  with no column fails at the first request.
- **No webhook can be received safely**: a JSON body reaches a route parsed, so
  no signature over the bytes received can be checked, and CEL has no
  constant-time comparison.

**The governing requirement:** `telo check` checks every path, the analyzer
knows the topology of every way the application can start, and no manifest
defect surfaces after boot. Every rule below follows from it: whatever cannot
be enumerated before boot is refused.

This builds on the `needs:` block and the `Telo.Url` value type, both already
in place; only the section "Over `needs:`" and the second projection use them.
The database example also uses `Telo.DurableDirectory`, one of the
kernel-declared need types still to land: that example runs once it exists,
and nothing else here waits for it.

## Delivery order

One plan, four parts, landing in this order — each part is merged only once the
one before it is green:

1. **Scope members are checked** — the per-resource pipeline over `with:`
   members, with no new syntax. The choice positions of Part 2 inside `with:`
   depend on it.
2. **The expansion language** — the three tags in every position, the binding
   record, identity, absence, families, step repeats, decidability,
   configurations, per-configuration inputs and needs, optional resource
   inputs and the init edge through an import, and the
   `scheduled-jobs-app` blueprint, shipped in one telo release: the binding
   spelling and member identity cannot change once traces carry them, and
   shipping a position later would first ship a refusal whose only future is
   deletion.
3. **CRUD over a declared table** and the `crud-app` blueprint.
4. **Webhook verification** — bytes bodies on a route, HMAC, verifiers — and
   the `webhook-app` blueprint.

## Part 1 — Scope members are checked

Before: an item of an `x-telo-scope` field (a `Run.Sequence`'s `with:`) is
validated only by the kernel, when its scope opens.

After: every such item is a declaration of its holder's module, scoped to the
holder, and runs through the full per-resource pipeline:

- **Names** resolve scope-first, then the module, as the kernel resolves them;
  `DUPLICATE_RESOURCE_NAME` applies within one scope.
- **Checked**: schema against the member's kind (inline extraction and defaults
  included); reference forms and slots against the scope plus the module
  (`INVALID_REFERENCE_FORM`, `REF_SLOT_COMPUTED`, kind acceptance,
  `UNRESOLVED_REFERENCE`); CEL typing, with the scope's own
  `resources.<member>` visible inside its regions and the existing startup-read
  rule for scoped providers; call sites and contracts; value types and host
  paths; resource and referrer rules; `x-telo-schema-from`,
  `x-telo-value-schema-from` and projections; deprecation warnings; and a
  template view for a member of a templated kind.
- **Whole-application passes** count members as nodes in their holder's scope:
  the call graph, init order inside the scope, zones, throws, sink attachment.
- Diagnostics anchor at the member's path inside its holder. The kernel is
  unchanged — it already validates members when a scope opens. The position is
  recognised through `x-telo-scope`, never through a field name, so a
  third-party kind's scope field is covered with no analyzer change.

*Verify*: a `Run.Sequence` whose `with:` member has a misspelled field, an
unresolved `!ref` and a CEL typo gets three diagnostics from `telo check`, at
the member's paths, each pinned in `tests/check-run-agreement.yaml` against the
kernel's refusal; a third-party kind with its own `x-telo-scope` field gets the
same three.

## Part 2 — The expansion language

### The three tags

| Tag | Forms | Valid at |
|---|---|---|
| `!for-each` | value `{ in, as?, emit }`; entry `{ in, as?, key, emit }`; declaration (a family) `{ metadata, in, as?, emit }`; step repeat `{ name, in, as?, emit }` | inside a template body only: an item of any list (value form); the value of a `...` splice key (entry form); a `resources:` entry or an `x-telo-scope` member (declaration form); an item of a step list (step-repeat form, or the value form) |
| `!if` | value `{ if, then, else? }`; declaration `{ metadata, if, then, else? }` | inside a resource declaration, an item of any list or the value of any field (value form); a whole resource document, a template body's `resources:` entry, an `x-telo-scope` member (declaration form); an item of a module doc's `targets:` (value form) |
| `!switch` | value `{ switch, cases, default? }`; declaration adds `metadata` | the same positions as `!if` |

A tag is expanded before any other check reads the manifest, so no host schema
admits it and every downstream pass — schema, references, CEL typing, call
graph, zones, throws, rules — runs over the expanded manifest. The loader turns
each tag into a sentinel, as it does `!ref`, in both templating halves (Node
and Rust). The keys of `!if` / `!switch` are the step grammar's (`if` /
`then` / `else`, `switch` / `cases` / `default`); the tag is what tells the two
apart — a step's `if:` is decided per call, `!if` before boot. Conditions,
selectors, `in:` and `key:` are written behind `!cel`, or as literals.

**The tags' own mappings have a grammar.** Every form above is a built-in entry
in `sdk/builtins/`, read by both analyzers and both loaders. An unknown key
(`thne:`), a missing required key, `metadata` missing at a declaration position
or present anywhere else (a value position, a nested tag, a branch), `key:`
anywhere but a splice or missing at one, and `name:` outside a step list are
`BRANCH_SHAPE_INVALID` for `!if` / `!switch` and `REPEAT_SHAPE_INVALID` for
`!for-each`.

**Where a tag is refused.** Names, kinds and dimensions are the same in every
configuration; only what stands behind a name varies. So:

- `!if` / `!switch` are `BRANCH_POSITION_INVALID` at the tag: as the first
  document of a module file (the module doc is never chosen, and the "must
  start with a `Telo.Application` / `Telo.Library`" diagnostic is held back,
  since the tag is the cause); anywhere in a module doc except an item of
  `targets:` — `imports:` (imports are not chosen), `variables:` / `secrets:` /
  `ports:` / `needs:` (they declare the dimensions), `include:`, `requires:`,
  `exports:`, `lifecycle`, `metadata`, `logging:` / `tracing:` (a sink entry
  already takes `when:`); and anywhere in a `Telo.Definition`, `Telo.Abstract`,
  `Telo.NeedType` or `Telo.Import` except inside a definition's template body —
  its `resources:`, `targets:`, dispatch slots and their `inputs:` / `result:`.
- `!for-each` outside a template body is `REPEAT_OUTSIDE_TEMPLATE`: its source
  is a consumer's literal data, which only a template receives. Inside one, a
  `!for-each` at a field value, and a `...` key whose value is not a
  `!for-each` or a list of them, are `REPEAT_POSITION_INVALID`.

### `!for-each`

- **The source is a typed collection.** `in:` is a bare `self.<path>` or
  `<binding>.value.<path>` whose schema is an array or a map
  (`additionalProperties` / `patternProperties`) — a scalar, an open value or a
  union is `REPEAT_SOURCE_INVALID`, at the definition.
- **The source is literal.** The consumer's collection must be literal in their
  manifest, through any chain of bare `self.` forwards and any crossing allowed
  by "Decidability" below; a computed one is `REPEAT_COMPUTED`, at the
  consumer's key. Element VALUES may hold CEL. A list taken from the
  environment has a length nobody knows before boot, so no configuration can
  stand in for it.
- **One binding per loop.** A `!for-each` binds exactly one name, `each`, or
  the name its `as:` gives. It holds a closed record: `value` (the element,
  typed as the source's `items` or map value schema), `index` (`int`, its
  position in declaration order) and, for a map source only, `key` (`string`).
  `each.key` over a list source is `CEL_UNKNOWN_FIELD`. The binding is constant
  per element and in scope in every expression inside `emit:`, including ones
  evaluated later (a route's `inputs:` may read `each.value.secret` beside
  `request.body`); expansion closes each expression left compiled inside an
  emitted item over the values of every enclosing binding.
- **No shadowing.** `BINDING_NAME_RESERVED` is reported at the inner `as:` (or
  the tag, when `as:` is omitted) when a nested `!for-each` reuses an enclosing
  loop's name; at the `as:` when an emitted item's own kind binds that name at
  a site inside `emit:`, or when the name is a CEL keyword, a CEL global at that
  site (`self`, `variables`, `secrets`, `ports`, `module`, `resources`,
  `steps`, `inputs`, `request`, `error`) or a module-call receiver; and at the
  key when an `x-telo-bindings-from` key inside `emit:` reuses it. The
  identifier pass judges `as:` too (`INVALID_NAME`, `NAME_CASE_CONVENTION`).
- **Forwarding is today's rule**: a bare `!cel "each.value"` or
  `!cel "each.value.<path>"` forwards the value untouched, references
  included, exactly as `self.<path>` does; any other expression yields data,
  and a computed value at a reference slot is `REF_SLOT_COMPUTED`. The
  template's schema marks every reference slot under the element with
  `x-telo-ref`.
- **What `emit:` is depends on the position.** At a list position, the
  element's items: one item, or a sequence of several, in emit order per
  element (an item that is itself a list is written as a one-element
  sequence). At a splice, the value of the element's one entry, so a sequence
  there is a list value. At a declaration position, exactly one unnamed
  declaration or a nested tag; a sequence there is `REPEAT_EMIT_INVALID`. Any
  emitted item may itself be an `!if`, `!switch` or `!for-each`. Each emitted
  item is held to the schema of the position it fills — a list's item schema, a
  map's schema at that key — as a literal there would be; in a templated
  `targets:`, each emitted declaration is also judged by
  `TEMPLATE_TARGETS_CAPABILITY`. An `emit:` at a list position or a splice whose
  declaration carries `metadata` is `REPEAT_EMIT_INVALID`: every element would
  declare the same name.
- **Order**: the consumer's declaration order; an empty collection emits
  nothing.
- **A map source may not have integer-like keys** (`"1"`, `"2024"`):
  `REPEAT_NUMERIC_KEY`, at the consumer's key. A JavaScript object puts such
  keys first in numeric order whatever order they were written in, and the Rust
  half's order depends on its map type, so declaration order — which decides
  `targets:` start order — would differ from what the author wrote.

#### Splicing map entries — `...`

Inside a template body, the mapping key `...` is a **splice**: its value is a
`!for-each` in its entry form, or a list of them, and each element contributes
one entry, keyed by `key:` with value `emit:`, at the place the `...` entry is
written — beside literal entries, at any depth, a resource's root included.

- `key:` is CEL that types to `string`, evaluated by the analyzer under the
  restrictions a condition has; one that does not type to `string`, throws or
  calls a forbidden function is `REPEAT_KEY_INVALID`. It may read only bindings
  and literal parts of the element; anything else is `REPEAT_COMPUTED` at the
  consumer's value.
- Per consumer and configuration: two elements emitting one key, or an emitted
  key equal to a literal key or to another splice's, is `REPEAT_KEY_DUPLICATE`
  at the consumer's element; an integer-like emitted key is
  `REPEAT_NUMERIC_KEY`; a closed `properties` map refuses an undeclared emitted
  key as `SCHEMA_VIOLATION`.
- Entries keep written order, a splice's entries in source order at its place.
  An `emit:` resolving to nothing (absence, below) leaves that element's entry
  out.
- Both loaders read `...` as a plain key, and the formatter and studio keep it
  where it was written. `...` is chosen over YAML 1.1's merge key `<<` because
  go-yaml (and the tools built on it), PyYAML and js-yaml give `<<` merge
  semantics, which would fold the tag's own keys into the parent mapping; `...`
  has no meaning as a key in any YAML version, and a splice is never at column
  0, where `...` would end a document. Inside a template body, a literal key
  spelled `...` cannot be written.

#### Families — N named resources

A `!for-each` at a declaration position is a **family**: its tag carries
`metadata`, and `emit:` is one unnamed declaration or a nested tag. Families
occur in template bodies only, as `resources:` entries and as `x-telo-scope`
members.

- **The family is one name** in the name table, judged once by
  `DUPLICATE_RESOURCE_NAME`, `INVALID_NAME`, `NAME_CASE_CONVENTION` and
  `TEMPLATE_ENTRY_NAME_DYNAMIC`. Families are never exported.
- **A member is referenced by binding**, `!ref <family>[<binding>.key]` or
  `[<binding>.index]`, one index per family depth, where each binding is a loop
  iterating the family's own source at that depth — so a member's existence is
  proven at the definition, never per consumer. There is no literal index: no
  template can know its consumer's keys.
- **Every element has a member**: a choice inside a family's `emit:` must be
  exhaustive (`!if` with `else:`, or `!switch`); an `!if` with no `else:` there
  is `REPEAT_EMIT_INVALID`. Filtering elements is an unnamed list-position
  repeat. A declaration-position choice whose branches differ in arity (one
  declaration in one branch, a family or a different depth in another) is
  `BRANCH_CASE_INVALID`.
- **`resources.<family>`** is a map from element key to member reading —
  `string` keys for a map source, `int` for a list source.
  `resources.<family>[<binding>.key]` is proven by the same rule as a `!ref`;
  any other index is an ordinary CEL map read, guarded with `in` / `.?`.
- `!ref <family>` with no index, an index on a name that is not a family, the
  wrong depth, a binding out of scope or iterating another source, the wrong
  member for the source (`key` over a list), and an alias with an index are
  `REF_MEMBER_INVALID`.

**The `!ref` grammar** has exactly three forms: `<name>`, `<Alias>.<name>`, and
`<family>` followed by one or more `[<binding>.key]` / `[<binding>.index]`.
`<family>` and `<binding>` follow the identifier grammar, no whitespace is
allowed, and there is no quoting rule inside the text. `[` and `]` are YAML
flow indicators, so inside a flow collection the scalar is quoted
(`{ store: !ref "stores[each.key]" }`); in block context it may stay plain. One
reader parses all three forms into one parsed reference (head, alias,
indexes); the Rust loader parses identically, and both run one shared set of
conformance vectors (text → parsed form or refusal). Every consumer reads the
parsed form: rename (renaming a family edits the head; renaming an `as:` edits
every index naming it), go-to-definition (the head goes to the family's tag, a
binding to its `as:` or tag), completion (inside `[` only bindings iterating
the family's source at that depth, after `.` the allowed member), studio's
reference picker, the module graph (an edge to the family box), and the
kernel, which substitutes binding values at expansion.

#### Step repeats

A `!for-each` may sit in a step list inside a template body — a list whose
items are the shared Step grammar.

- **Unnamed** (value form): the emitted steps carry no `name:`, and their
  results cannot be read.
- **Named** (step-repeat form): the tag carries `name:`, which joins the body's
  step-name table and its duplicate refusal; `emit:` is exactly one step.
  `steps.<name>` is a map from element key (`string`, or `int` for a list
  source) to `{ result }`, typed from the emitted step's result;
  `steps.<name>[<binding>.key].result` is proven by the families' same-source
  rule, any other index is an ordinary CEL map read. Emitted steps run in
  source order.
- An emitted step carrying `name:`, and a sequence in a named repeat's
  `emit:`, are `REPEAT_EMIT_INVALID`.

This is what makes per-member dispatch expressible: a step's target is a static
reference, so `invoke: !ref crons[each.key]` cannot be reached by runtime
iteration.

#### Identity of emitted items

An emitted item has no name of its own except as a family member. Its identity
is its **site** — the tag's position in the definition — plus its **index
path**: the element's `key` (map source) or `index` (list source) for each
enclosing loop, outermost first, rendered as CEL index literals.

- **A family member** is `<family><index path>` — `crons['nightlyReport']`,
  `ops['users']['list']`, `stores[0]` (single-quoted, CEL escapes). That text is
  its name in the instance's registry, its `telo.resource.name` on spans and in
  kernel events, how messages name it, and the same text as the CEL read
  `resources.crons['nightlyReport']`. It is output only, never a reference text,
  and never an identifier, so it cannot collide with an authored name.
- **An unnamed emitted inline declaration** is extracted like any inline
  declaration, with a generated identity formed from its holder's site and the
  index path — never from its position in the expanded list, which moves when a
  literal sibling is added. Messages call it "the `Scheduler.Cron` emitted for
  `jobs.nightlyReport`".
- **Plain values** have no resource identity; diagnostics anchor at the
  consumer's element path or the `emit:` path in the definition.
- **Reload** rebuilds a template instance whole, as any template field change
  does today; members are re-created under the same identities, so traces and
  events line up across reloads.

### `!if` and `!switch`

- **In a list**, the chosen branch is one item, or nothing. **As a field's
  value**, the chosen branch is the field's value; an `!if` with no `else:`
  whose condition is false contributes nothing, so the key is absent (below).
  Each branch is held to the schema of the position it fills, in every
  configuration that selects it.
- **At a declaration position** — a whole resource document, a template body's
  `resources:` entry, an `x-telo-scope` member — the tag carries the
  declaration's `metadata`, and every branch is one unnamed declaration,
  `{ kind, …fields }`, the shape an inline declaration has at a slot. In each
  configuration the choice expands to one declaration: the chosen branch's
  `kind` and fields under the tag's `metadata`. The name is written once, on
  the tag, so the name table is the same in every configuration:
  `DUPLICATE_RESOURCE_NAME`, `INVALID_NAME`, `NAME_CASE_CONVENTION` and, in a
  template body, `TEMPLATE_ENTRY_NAME_DYNAMIC` judge the tag's `metadata.name`
  once, with no configuration label, and rename, go-to-definition,
  `exports.resources` and the module graph's row identity read one site. Only
  the kind behind the name, or whether it exists, varies. An `!if` with no
  `else:` there declares a resource that exists in some configurations only; a
  reference to it from where it does not exist is the ordinary
  unresolved-reference diagnostic, reported for those configurations.
- **A branch at a declaration position** is one unnamed declaration of a
  resource kind, or a nested `!if` / `!switch` / family whose branches are —
  never a branch carrying `metadata`, a module doc, a `Telo.Definition`,
  `Telo.Abstract` or `Telo.NeedType`, an import, a list or a scalar
  (`BRANCH_CASE_INVALID`). A nested tag carries no `metadata`: the outermost
  tag holds the identity.
- **Inline when used once, a declaration-position choice when named.** A
  resource used once is a value-position choice at its slot
  (`connection: !if { … }`); it becomes a declaration-position choice only when
  something must name it — the rule a plain resource follows.
- **Imports are not chosen**: an application imports every backend it may run
  on, and only the chosen one's controller ever loads (controllers are resolved
  and loaded on a kind's first instantiation).
- A diagnostic inside a branch is anchored at the branch's own source path
  (`then.access`, `cases.postgres.access`), never at a path the expansion
  produced.
- **`switch:` evaluates to a string, an integer or a boolean**, and each case
  key is read as a value of that type — an integer as its decimal literal
  (`1`, never `01`), a boolean as `true` / `false`, a string as written — and
  matched by value. A key that is not a value of the selector's type is
  `BRANCH_CASE_KEY_INVALID`, at the key. `!switch` is exhaustive: in a
  configuration where no case matches and there is no `default:`,
  `BRANCH_NOT_EXHAUSTIVE`, naming the configuration and the value; absence
  decided by a selector is written as an enclosing `!if`. A well-typed case no
  configuration selects is `BRANCH_CASE_UNREACHABLE`, a warning — it is still
  checked.
- **`if:` evaluates to a boolean.**
- Branches nest inside each other and inside `!for-each`, in either order.

### Absence

**Where no branch is chosen, a tag contributes nothing to its container**: no
item in a list, no entry in a mapping (a resource's own fields and a map's
entries alike), no declaration at a declaration position, and nothing to an
enclosing tag when it is a branch or an `emit:`.

- The schema runs once per configuration with the key gone, so a `required`
  key left absent is `SCHEMA_VIOLATION`, labelled with those configurations.
- Reads inside an absent field do not count toward the inputs a configuration
  requires.
- The presence of a consumer's literal field is a literal fact; a field chained
  to an input admitting absence is that input's presence dimension, so
  `!if { if: !cel "self.licenseKey != null", then: … }` in a template is
  decidable.

### Decidability

Every value the analyzer decides before boot — a condition, a selector, an
`in:`, a `key:` — must be decidable. Each name it reads must resolve to one of:

- **a literal** — in the template's consumer, through any chain of bare
  `self.` / `<binding>.value.` forwards; a binding's `key` / `index`; or a
  `module.<field>` of the declaring module (a constant);
- **a dimension**: a projection of a root input whose domain the input's
  declaration closes, reached directly, or through a library's `variables:` /
  `secrets:` entry its importer binds to one, through any depth of imports.
  There are exactly three projections:
  1. **The whole value** of a `variables:` entry declared `enum`, `const` or
     `type: boolean`. Its domain is those values.
  2. **A member whose bound type argument is a closed domain**: a member of a
     value type whose entry binds a parameter to that member (`"member":
     "scheme"`), where the slot's argument for it is an `enum` or `const`
     schema — `secrets.databaseUrl.scheme` at `x-telo-type: { name: Telo.Url,
     scheme: { enum: [sqlite, postgres] } }`. Its domain is those values. The
     rule names no type: it covers every member-bound parameter (`Telo.Url`'s
     `user`, `path` and `query` as well), and a non-sensitive member is never
     redacted, whatever input holds it.
  3. **Presence**: a bare input path compared with `null`
     (`!cel "secrets.openaiApiKey != null"`, `!cel "resources.store == null"`).
     Its domain is `present` | `absent`.

**Reading through a reference.** A bare `self.<path>` or
`<binding>.value.<path>` may cross every reference it meets into the
declaration that reference names, provided that declaration is in the
consumer's own module. Past the reference it reads the declaration as written,
with its kind's schema defaults filled — never a published reading — and what
it finds there must be a literal or a chain to a dimension, in which case it is
that dimension. Each element of a list of `!ref`s crosses into its own
declaration, so `in: !cel "table.value.columns"` over a list of table
references works, and `if: !cel "self.a.mode == 'x'"` reads `a`'s literal
`mode`. A reference to a declaration-position choice reads the branch chosen in
each configuration; static typing past a reference comes from the referenced
kind's author schema. Module-level conditions read only dimensions, so no
condition can depend on itself. Crossing into another module's declaration is
`BRANCH_UNDECIDABLE` (`REPEAT_COMPUTED` for `in:` / `key:`) at the consumer's
reference, naming the module: it would couple the consumer's configurations to
a library's non-contract configuration, which a patch release can change.

**An input admits absence** when its declaration says so: a `variables:` /
`secrets:` entry declaring `default: null`, in an Application or a Library; an
optional need (below); or a Library `resources:` entry declaring
`optional: true` (below). Its CEL type is then nullable, so an unguarded read is `CEL_NULLABLE_ACCESS`, and
`DEFAULT_INVALID` accepts `null` there whatever its `type:`. A `ports:` entry
never admits absence: `default: null` on one is `DEFAULT_INVALID`. A presence
test on an input that cannot be absent is constant, so its dead branch is
`BRANCH_CASE_UNREACHABLE`; so is the dead branch of any condition constant in
every configuration.

**A dimension narrows.** In a configuration where an input is `present`, it is
non-null: reading it needs no guard. In one where a `scheme` dimension holds a
value, the member is that literal.

Anything else is `BRANCH_UNDECIDABLE` (`REPEAT_COMPUTED` for `in:` / `key:`),
reported where the open value is written: a consumer's computed value, any
other read of an input (its whole value when its domain is open,
`secrets.databaseUrl.host`), a `ports` read, `inputs`, `request`, `steps`, a
resource's published state. A condition is evaluated by the analyzer under the
restrictions a resource rule's condition has — no host-backed and no
non-deterministic function — and one that does not parse, does not type-check,
throws, or yields the wrong type is `BRANCH_CONDITION_INVALID`.

**A diagnostic is anchored where the defect can be fixed**: the template's own
logic at the template, a value the consumer wrote at the consumer.

- For a selector or condition reading only `self`, bindings and the library's
  own inputs, exhaustiveness, reachability and case keys are decided at the
  definition, against the domain the kind's schema closes at that read path —
  `enum`, `const` or `boolean`; through a binding, the source's element schema;
  through a crossing, the referenced kind's schema; the library's own
  dimensions multiply in. An open domain with no `default:` is
  `BRANCH_NOT_EXHAUSTIVE` at the tag; a case outside the closed domain is
  `BRANCH_CASE_UNREACHABLE` at the case. A consumer value outside the `enum` is
  already `SCHEMA_VIOLATION` at the consumer's key, and a consumer's open value
  feeding a selector is `BRANCH_UNDECIDABLE` at that value. No exhaustiveness
  or reachability diagnostic is ever anchored at a consumer or repeated per
  consumer.
- What stays at the consumer: `REPEAT_COMPUTED`, `REPEAT_NUMERIC_KEY`,
  `REPEAT_KEY_DUPLICATE`, and `SCHEMA_VIOLATION` inside forwarded values.

**A template definition is checked with no consumer too**: every branch's
content is checked against its entry kind's schema with `self` typed from the
kind's schema, and every `emit:` with each binding typed from its source path —
through a reference, from the referenced kind's schema. A typo inside a branch
nobody selects, or inside an `emit:` when the template's own tests pass an
empty list, fails the template's own `telo check`.

### Refused by design

Each of these stays inexpressible, because allowing it would leave a path
unenumerable before boot or a name declared in more than one place:

- **A list from the environment**, and any computed source: its length is
  unknown before boot (`REPEAT_COMPUTED`).
- **N copies by count** (`replicas: 3`): a count names no member. Concurrency
  inside one resource is that kind's own field; N addressable peers are N
  entries of a map the consumer writes, which a family turns into named
  members; running a process N times is the runner's replica count.
- **Multi-select flags** (an array variable with `enum` items): declare one
  `type: boolean` variable per flag — each its own dimension, bound to its own
  env name or argument.
- **A bounded integer as a dimension**: `minimum` / `maximum` say which values
  are valid, not which behave differently, and a wide bound would multiply the
  configurations by its width. Declare an `enum` of the values that select
  different behaviour.
- **An optional port**: under any runner every declared port is assigned, so
  "the port is set" would always be true there and one manifest would start a
  different topology locally. A `type: boolean` variable (`ADMIN_ENABLED`,
  `default: false`) chooses the admin server, and the port keeps a `default:`.
- **A library choosing by the concrete kind an importer handed in** through a
  `resources:` input: what differs per variant reaches the library through what
  the abstract declares (a field, a status, an invocable), or the importer
  makes the choice.
- **A grouped choice** ("Postgres ⇒ connection + pool + migrator"): each name
  is its own declaration-position choice over the same selector; every
  configuration is checked whole, so a migrator referencing a pool absent in
  some configuration is an unresolved reference there. A group would declare
  names inside branches.
- **A shared base for branches**: a resource whose kind is the same in every
  branch is one declaration with field-value choices; branches of different
  kinds share keys only through what their abstract declares.
- **A member joining a collector from the member side** (a table declaring
  the schema it belongs to): the collector's set would stay open over time — a
  `with:` scope or a later import adds members after it has run its one pass —
  and a library's patch release could change what an application's ledger
  owns.
- **A fallback that must be registered with a collector**, and a default
  instance named by the input it stands in for (`default: !ref …` on a
  resource input): one name would be borrowed in some imports and owned in
  others. A registered member is a ready-made instance a module that does not
  borrow that collector exports, listed by the collector's owner.
- **Choosing an import, a variable's `default:`, an `include:` or a kind's
  schema**: `BRANCH_POSITION_INVALID`; an import's `variables:` value is chosen
  with a `!cel` ternary, never with a tag.

### Configurations

A **configuration** is one assignment of a value to every dimension a condition
or selector reaches. The set is the product of the dimensions' domains; an
input no condition reaches is not a dimension. `variables.dialect` with
`[sqlite, postgres]` × `secrets.openaiApiKey` with `[present, absent]` is four
configurations.

**A dimension is keyed by the path it is read at** — `variables.dialect`,
`secrets.databaseUrl.scheme`, `secrets.openaiApiKey` — so a variable and a
secret of one name never collide. The same keys are used in
`data.configurations`, `requiredWhen` and `Kernel.Starting`.

- **The analyzer checks every configuration.** Expansion runs once per
  configuration, and every check over the whole application runs over each
  expanded set: references, init order and cycles, the call graph and
  everything read from it (zones, throws and `catches:` coverage, referrer
  rules, observed-state reads), resource rules, sink attachment, exports, and
  the module graph. There is no cap on the number of configurations: a cap
  would leave a path unchecked.
- **A resource is checked once per distinct set of what it reaches.** Being
  outside every branch makes a resource identical as written, not identical as
  typed: `connection: !ref db` is judged against a different kind in each
  configuration where `db` is a choice. So the per-resource checks — schema,
  reference slots, CEL typing, contracts, schema derivation — run once for a
  resource whose own expansion, and every declaration it references or reads
  (`!ref`, `resources.<name>`, `steps.<name>.result`, `x-telo-schema-from`,
  `x-telo-value-schema-from`, projections, template views over its values),
  are the same in every configuration, and once per distinct combination
  otherwise, each diagnostic carrying the configurations it arose in. Scope
  members (Part 1) are covered the same way.
- **In each configuration a whole-value chain to a dimension is that
  configuration's literal**, judged as a literal at its slot. So
  `dialect: !cel "variables.dialect"` declared `enum: [sqlite, postgres, mysql]`
  into a slot declaring `enum: [sqlite, postgres]` is a schema violation in the
  `mysql` configuration.
- **Diagnostics name their configurations.** A diagnostic arising in every
  configuration carries no label. One arising in some carries
  `data.configurations` — the list of assignments — and its message names the
  smallest description of that list, omitting any dimension whose every value
  is present (`… (when variables.dialect is postgres)`,
  `… (when secrets.openaiApiKey is absent)`). `telo check`, the language
  server and studio all render that one message.
- **A library's own check** takes as its dimensions its own `variables:` /
  `secrets:` entries a condition reads through one of the three projections,
  and the presence of each of its optional `resources:` entries a condition
  reads. A consumer's check takes the dimensions its own bindings reach, so a
  library imported with `dialect: postgres` is checked once; and it reads each
  import's resource supply as a literal fact, so a library's inputs never
  multiply an application's configurations.
- **The analysis stamp covers every configuration**, so a warm load checks
  nothing again whichever configuration starts.
- **What is repeated** is the checks over the whole application, and the
  per-resource checks of a resource whose expansion or reach varies. Analysis
  time grows with the number of configurations for exactly those.

### Inputs required per configuration

Before: an input with no `default:` is required whether or not anything reads
it, so an app choosing between two AI providers demands both API keys.

After: an Application `variables:` / `secrets:` / `ports:` entry with no
`default:` is **required in exactly the configurations in which a manifest read
reaches it** — a CEL read in a resource or field that exists in that
configuration, or an import's `variables:` / `secrets:` entry forwarding it
(itself possibly behind `!if`). A dimension is always required unless it has a
`default:`; an entry declaring `default: null` is never required, since absent
is one of its values. An entry no configuration reads is never required.

- The derivation sees manifest reads only; inputs reach a controller through
  its resource's fields, and no standard-library controller reads a module's
  inputs any other way. The module-author guide states it.
- `telo run --help` names each dimension by its env name: `required when
  AI_PROVIDER is openai`, `required when OPENAI_API_KEY is unset`.
- `telo module manifest --json` gives each `application` input a
  `requiredWhen` list of assignments keyed by path
  (`[{ "secrets.openaiApiKey": "absent" }]`), absent when the input is
  unconditional. Runners and studio read it to ask for what the chosen
  configuration needs.
- **Ports under a runner.** Runners expose and assign every declared `ports:`
  entry in every configuration, and `Kernel.PortsResolved` lists every port. A
  port's per-configuration requiredness governs only `telo run`'s own input
  validation: a port no configuration of this start reads is not demanded.
  `requiredWhen` is still reported for ports; runners do not use it to choose
  which ports to assign.

### Runtime

- **Load order.** The kernel resolves every dimension first, by the usual
  precedence (supplied by name, argv, env, `default:`), and validates it
  against its schema; an input admitting absence that nothing supplies is
  `absent`. A value outside its domain — an enum value not listed, a URL whose
  scheme its `scheme` argument refuses — is `ERR_MANIFEST_VALIDATION_FAILED`
  (`Telo.Url`'s own `ERR_URL_INVALID` for a URL), naming the input and its
  allowed values, before any resource is created — the one refusal analysis
  cannot remove, since no check sees the environment. It then expands the
  documents for that configuration and resolves the inputs that configuration
  requires, under the same code.
- **Only the chosen branch exists.** Unchosen branches are never registered or
  created, so their kinds' controllers are never resolved, built or fetched.
- **Template bodies** are expanded at the instance's `init()`, where the body is
  registered today, for the running configuration; families, splices and step
  repeats are expanded there too, with every binding's values substituted.
- `Kernel.Starting` carries `{ telo, configuration }`, the dimension values the
  process started with.
- **Reload** rebuilds a template instance whole; a dimension change needs a
  restart, since its value comes from the process's inputs. A manifest edit is
  reconciled over the expanded set of the running configuration.
- **Each error-level code has a kernel twin**, `ERR_<code>`, raised where the
  kernel first meets the defect — at load for a document, at definition
  registration for a definition, at creation for a consumer's value — so a
  dependency whose own check was never run cannot reach boot unrefused. Each
  pair is added to `tests/check-run-agreement.yaml`, pinned at the declaring
  library and at a consumer whose entry-scoped check is silent.

### Over `needs:`

Before: every need reaching the root unsupplied is required, so an app taking
PostgreSQL when its URL is set and SQLite otherwise demands both, and a `!ref`
to an optional need is always `NEED_OPTIONAL_REFERENCED`.

After:

- **An optional need's presence is a dimension** whenever a condition reads it
  (`!cel "resources.databaseAccess != null"`), keyed `resources.<need>`. A need
  is present when any of these holds: a supply at an import, every required env
  name of it set, or — for a kernel-declared type — its host value. Some but not
  all required env names set stays `ERR_NEED_PARTIALLY_SUPPLIED` at load.
- **A need's field may be a dimension** through the second projection:
  `resources.databaseAccess.url.scheme`, where the need type's `url` field
  declares `scheme: { enum: [...] }` (`Postgres.DatabaseAccess` declares
  `[postgres, postgresql]`).
- **A non-optional need is required in exactly the configurations its field
  reads, `!ref`s or import forwards reach.** `ERR_NEED_UNMET` at load covers
  only the needs the running configuration reaches; one no configuration
  reaches is never required.
- **Presence narrows a need.** In a configuration where it is `present`, a
  `!ref` to it is legal and its fields read non-null.
  `NEED_OPTIONAL_REFERENCED` / `ERR_NEED_OPTIONAL_REFERENCED` is reported only
  in the configurations where the need may be absent, labelled with
  `data.configurations`.
- **Load order.** The kernel resolves every dimension — variables, secrets,
  `scheme` members and need presence — then expands the documents for that
  configuration, then resolves the needs and inputs that configuration reaches,
  before any resource is created.
- **The needs report** (`telo needs report -o json`) gains a `dimensions` list,
  each entry `{ key, values, env }` (`env` the env names its value is read
  from), and a `requiredWhen` list per need, keyed by path and absent when the
  need is unconditional. It stays `reportVersion: 1`, since both are additions.
  The text report prints `required when DATABASE_URL is unset`.

*Verify*, in the root suite over a fixture need type and a fixture consumer
kind, so nothing needs to be running — an application declaring an optional
need `a` and a required need `b`, with `!if` choosing between a consumer of
`a` and a consumer of `b` on `resources.a != null`:

- With `a`'s env name set it starts on `a`'s consumer and does not require
  `b`; with neither set it is `ERR_NEED_UNMET` naming only `b`'s env names,
  before any resource is created.
- `telo check` refuses a `!ref a` at the consumer's slot outside a branch
  proving `a` present and accepts it inside one; both pinned in
  `tests/check-run-agreement.yaml`, with `ERR_NEED_OPTIONAL_REFERENCED` from a
  silent consumer.
- `telo needs report -o json` lists the dimension `resources.a` (`present` /
  `absent`, `a`'s env names) and gives `b`
  `"requiredWhen": [{ "resources.a": "absent" }]`.
- Once `Telo.DurableDirectory` exists, the database example below starts on
  PostgreSQL with `DATABASE_URL` set, on SQLite with only
  `TELO_HOST_STATE_DIR` set, and is `ERR_NEED_UNMET` naming only
  `TELO_NEED_DATA__PATH` with neither.
- A two-field optional need with one env name set is
  `ERR_NEED_PARTIALLY_SUPPLIED` before any resource is created.
- A condition reading `resources.databaseAccess.url.host` is
  `BRANCH_UNDECIDABLE`.

### Over `resources:` inputs

Before: every entry of a Library's `resources:` block must be supplied at
every import (`RESOURCE_INPUT_MISSING`), so a library cannot offer a default
for an instance its importer may or may not hand over. And a library that
borrows a collector (a `Sql.Schema`) while exporting a member that collector
lists (a table) deadlocks at init with nothing reported before boot, because a
reference through an import alias is only a soft init-order edge.

After:

- **An entry may declare `optional: true`** — the key `needs:` entries already
  carry; there is no `default:` key on a resource input. Inside the library,
  `resources.<input>` is then nullable (`CEL_NULLABLE_ACCESS` unguarded), and
  its presence, read only as a bare `resources.<input> != null` / `== null`,
  is the presence projection, keyed `resources.<input>` — the key form
  optional needs use. A non-optional entry stays required at every import.
- **The fallback is the library's own declaration-position `!if`** on
  `resources.<input> == null`, declaring the default under a name of its own;
  a use site chooses with a field-value `!if` whose `then:` is
  `!ref <input>` and `else:` the default (or the default inline in `else:`
  when it is used once). `!ref <input>` is legal only in a branch proving the
  input present; elsewhere it is `RESOURCE_INPUT_OPTIONAL_REFERENCED`.
- **Two names, two ownerships.** The input is always borrowed, never torn down
  by the library's context; the default is always owned — by the import's
  child context, or by the root-spawned context of a `lifecycle: shared`
  library — and exists only in the configuration where the input is absent,
  so it is never created when the importer supplies one.
- **Presence per import is a literal fact.** An import supplies an input or
  does not, and neither imports nor `!ref`s are chosen, so in an importer's
  check no label is printed and nothing multiplies; only the library's own
  check enumerates `present | absent`, labelled `(when resources.<input> is
  absent)`. The kernel's import controller expands the library's documents
  with that import's facts before registering any of its resources;
  per-import presence is not part of `Kernel.Starting`'s configuration.
- **A `lifecycle: shared` library** has one configuration: one import supplying
  an input and another omitting it is `SHARED_LIBRARY_CONFLICT` /
  `ERR_SHARED_LIBRARY_CONFLICT`, naming both aliases and `resources.<input>`,
  decided statically across modules since presence is literal at every import.
- **A member that must be registered with a collector is never a fallback.**
  Membership is declared only by the collector — a `Sql.Schema`'s tables, a
  server's mounts, `logging.sinks` — by reference, in the module declaring the
  collector. A module offering such a member exports it as a ready-made
  instance the collector's owner lists (`!ref <Alias>.<table>`), and must not
  borrow that same collector; a module that both consumes a collector and
  supplies members to it moves the members into a leaf module that borrows
  nothing. An export declared only in some configurations is legal, and a
  reference where it does not exist is the ordinary unresolved reference,
  labelled with its configuration or the import's literal fact.
- **An instance reference through an import alias is a hard init-order edge**
  to that import — a resource-level `!ref <Alias>.<name>` or a startup read of
  `resources.<Alias>.<name>` — because an export exists only once its import has
  initialized; a kind spelled through an alias stays soft and step edges stay
  out of init order. A resource supplied to an import (its `resources:`, or a
  whole `needs:` supply) that reaches an export of that same import through
  hard edges is `DEPENDENCY_CYCLE` at check and `ERR_CIRCULAR_DEPENDENCY` at
  load, before anything initializes — today an unclassified init-loop failure.
  Both halves add the edge, so `telo check` and load agree.
- **The graph stores stay fully declared.** Their bookkeeping tables
  (`layers`, `drafts`, the revisions strategy's) are members of the
  application's schema and shared by a layer and its bases
  (`GRAPH_BASE_STORE_MISMATCH`), so the schema's owner declares them; the
  slots stay required and no graph module changes.

*Verify*:

- A fixture library with an optional input `store`, a declaration-position
  default and a field-value `!if` at its slot: an import supplying `store` uses
  it and emits no `Created` event for the default; an import omitting it
  creates the default, which is torn down with the child while a supplied
  instance outlives the child's teardown.
- The library's own `telo check` covers two configurations, a typo in the
  default reported `(when resources.store is absent)`; the consumer's check
  prints no label.
- `!ref store` outside a proving branch fails the library's own check, is
  reported at an omitting consumer's `imports:` entry with that run failing
  `ERR_RESOURCE_INPUT_OPTIONAL_REFERENCED`, and a supplying consumer boots.
- A shared library imported once supplying and once omitting the input is
  `SHARED_LIBRARY_CONFLICT` and `ERR_SHARED_LIBRARY_CONFLICT`.
- A library taking `schema` as an input and exporting a table the
  application's schema lists is `DEPENDENCY_CYCLE` naming the import from
  `telo check`, and `ERR_CIRCULAR_DEPENDENCY` from `telo run` before anything
  initializes; a leaf exporting a ready-made table, listed by the application's
  schema and handed to a store, boots; `!ref Lib.sweep` invoked from a step
  inside a resource supplied to `Lib` raises no cycle.
- A templated store wrapper declaring a default bookkeeping table is refused
  by `telo check` with `GRAPH_TABLE_NOT_IN_SCHEMA`, and every graph store kind
  keeps its bookkeeping slots required.

### `targets:` widening

A templated `Telo.Service` / `Telo.Runnable`'s `targets:` accepts, beside
`!ref <entry>`, an inline declaration, a `!for-each` item (value form, emitting
declarations or `!ref <family>[<binding>.key]`) and an `!if` / `!switch` item.
An Application's `targets:` accepts `!if` / `!switch` items.

### Examples

Import sources are written as an in-repo manifest under `tests/` reaches them.

**A backend is chosen by the environment through the presence of the chosen
backend's own input.** Each alternative stays a typed input, so the needs
report tells whoever provisions the app what each configuration takes. An app
for which a missing input must be refused rather than fall back keeps an
`enum` selector variable instead.

#### A database chosen by the environment

This one uses "Over `needs:`" above, and `Telo.DurableDirectory`, so it runs
once that kernel-declared type lands. `resources.databaseAccess` is a presence
dimension, so `telo check` checks two configurations. The tag declares `db`
and each branch only its kind, so every `!ref db` reaches whichever was
chosen. Inside the `then:` branch the optional need is proven present, so
`access: !ref databaseAccess` is legal there. `data` is reached only in the
`else:` branch, so it is required only when `DATABASE_URL` is unset.

```yaml
kind: Telo.Application
metadata: { name: Notes }
imports:
  Sql: ../modules/sql
  SQLite: ../modules/sqlite
  Postgres: ../modules/postgres
needs:
  databaseAccess:
    kind: Postgres.DatabaseAccess
    optional: true
    env: { url: DATABASE_URL }
  data:
    kind: Telo.DurableDirectory
--- !if
metadata: { name: db }
if: !cel "resources.databaseAccess != null"
then:
  kind: Postgres.Connection
  access: !ref databaseAccess
else:
  kind: SQLite.Connection
  file: !cel "resources.data.path.joinPath('notes.db')"
---
kind: Sql.Query
metadata: { name: listNotes }
connection: !ref db
```

- With `DATABASE_URL` set it starts on PostgreSQL, and `data` is not required.
- With only `TELO_HOST_STATE_DIR` set it starts on SQLite in
  `<state dir>/needs/data/notes.db`.
- With neither, it is `ERR_NEED_UNMET` naming only `TELO_NEED_DATA__PATH`,
  before any resource is created.
- `Kernel.Starting` carries `{ "resources.databaseAccess": "present" }` or
  `"absent"`, and the unchosen backend's controller never loads.
- `telo needs report -o json` lists the dimension `resources.databaseAccess`
  (`present` / `absent`, env `DATABASE_URL`) and gives `data`
  `"requiredWhen": [{ "resources.databaseAccess": "absent" }]`.

#### A model provider chosen by the environment

The same pattern for `Ai.Model`, with a secret. `openaiApiKey` declares
`default: null`, so it may be absent and its presence picks OpenAI;
`anthropicApiKey` is read only in the `else:` branch, so it is required only
when `OPENAI_API_KEY` is unset. The tag names `model`, and each branch is one
unnamed declaration; what it alone uses is declared inline beneath it. When
both keys are set, OpenAI is used, as the condition says.

```yaml
kind: Telo.Application
metadata: { name: Assistant }
imports:
  Ai: ../modules/ai
  Http: ../modules/http-client
  OpenAI: ../modules/openai
  Anthropic: ../modules/anthropic
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string, default: null }
  anthropicApiKey: { env: ANTHROPIC_API_KEY, type: string }
--- !if
metadata: { name: model }
if: !cel "secrets.openaiApiKey != null"
then:
  kind: OpenAI.ChatModel
  model: gpt-4o-mini
  request:
    kind: Http.Request
    client:
      kind: Http.Client
      baseUrl: https://api.openai.com/v1
      credential:
        kind: Http.BearerToken
        token: !cel "secrets.openaiApiKey"
else:
  kind: Anthropic.MessagesModel
  model: claude-haiku-4-5
  maxTokens: 1024
  request:
    kind: Http.Request
    client:
      kind: Http.Client
      baseUrl: https://api.anthropic.com/v1
      credential:
        kind: Http.ApiKeyHeader
        header: x-api-key
        key: !cel "secrets.anthropicApiKey"
---
kind: Ai.Agent
metadata: { name: assistant }
model: !ref model
system: You are a helpful assistant.
```

- `secrets.openaiApiKey` needs no guard in the `then:` branch: the
  configuration proves it present.
- `--help` marks `anthropicApiKey` `required when OPENAI_API_KEY is unset`;
  `telo module manifest --json` gives it
  `"requiredWhen": [{ "secrets.openaiApiKey": "absent" }]`.
- With neither key set, the run is `ERR_MANIFEST_VALIDATION_FAILED` naming
  `anthropicApiKey`, before any resource is created.
- Together with the database example in one application, `telo check` checks
  four configurations, and a diagnostic arising only under Anthropic reads
  `… (when secrets.openaiApiKey is absent)`.

#### A field present only when an input is

A supervisor hands its child a license key only when it has one. The field-value
`!if` has no `else:`, so with the secret unset the child's `secrets:` map has no
`licenseKey` entry at all.

```yaml
kind: Telo.Application
metadata: { name: Supervisor }
imports:
  App: ../modules/app
secrets:
  licenseKey: { env: LICENSE_KEY, type: string, default: null }
---
kind: App.Instance
metadata: { name: worker }
source: ./worker
secrets:
  licenseKey: !if
    if: !cel "secrets.licenseKey != null"
    then: !cel "secrets.licenseKey"
```

#### One list into N resources — ScheduledJobs

```yaml
kind: Telo.Library
metadata: { name: ScheduledJobs }
imports:
  Scheduler: ../modules/scheduler
exports:
  kinds: [App]
---
kind: Telo.Definition
metadata: { name: App }
capability: Telo.Service
schema:
  type: object
  required: [jobs]
  properties:
    jobs:
      type: object
      additionalProperties:
        type: object
        required: [cron, invoke]
        properties:
          cron: { type: string }
          invoke:
            x-telo-ref: { kind: Telo.Executable, use: trigger.inbound }
resources:
  - !for-each
    metadata: { name: crons }
    in: !cel "self.jobs"
    emit:
      kind: Scheduler.Cron
      cron: !cel "each.value.cron"
      invoke: !cel "each.value.invoke"
targets:
  - !for-each
    in: !cel "self.jobs"
    emit: !ref crons[each.key]
```

The consumer lists its jobs literally; a malformed `cron` is reported at
`jobs.nightlyReport.cron`, `jobs: !cel "variables.jobs"` is `REPEAT_COMPUTED`,
and the member started for `nightlyReport` carries
`telo.resource.name: crons['nightlyReport']`. With no need to name the crons,
the family is dropped and `targets:` emits the `Scheduler.Cron` declarations
inline.

```yaml
kind: ScheduledJobs.App
metadata: { name: jobs }
jobs:
  nightlyReport:
    cron: "0 2 * * *"
    invoke: !ref buildReport
  hourlyCleanup:
    cron: "0 * * * *"
    invoke: !ref purgeExpired
```

#### Several routes per element, nested loops

Every emitted route lands in the one `Http.Api`; each hook yields a POST and a
GET route, interleaved per hook. `hook.key` and `hook.value` are constants of
the element, read beside the per-request `request`. The second repeat nests a
loop over each table's operations and reads both loops' bindings.

```yaml
resources:
  - kind: Http.Api
    metadata: { name: api }
    routes:
      - !for-each
        in: !cel "self.hooks"
        as: hook
        emit:
          - request:
              path: !interpolate "/hooks/${{ hook.key }}"
              method: POST
            inputs:
              source: !cel "hook.key"
              event: !cel "request.body"
            handler: !cel "hook.value.handler"
            returns:
              - status: 202
          - request:
              path: !interpolate "/hooks/${{ hook.key }}"
              method: GET
            handler: !cel "hook.value.status"
            returns:
              - status: 200
      - !for-each
        in: !cel "self.tables"
        as: table
        emit:
          - !for-each
            in: !cel "table.value.operations"
            as: op
            emit:
              request:
                path: !interpolate "/${{ table.key }}/${{ op.value.name }}"
                method: POST
              handler: !cel "op.value.handler"
              returns:
                - status: 200
```

#### Literal and generated map entries — a splice

The `id` column is literal; one column per consumer field is spliced beside it.

```yaml
resources:
  - kind: SQLite.Table
    metadata: { name: records }
    table: records
    columns:
      id: { type: integer, primaryKey: true }
      ...: !for-each
        in: !cel "self.fields"
        key: !cel "each.key"
        emit:
          type: !cel "each.value.type"
```

A consumer field named `id` is `REPEAT_KEY_DUPLICATE` at that consumer key.

#### Presence decided by configuration — one server or two

```yaml
kind: Telo.Definition
metadata: { name: Service }
capability: Telo.Service
schema:
  type: object
  required: [port, adminPort, api, admin]
  properties:
    port: { type: integer, x-telo-eval: compile }
    adminPort: { type: integer, x-telo-eval: compile }
    api: { x-telo-ref: { kind: Telo.Mount, use: dependency } }
    admin: { x-telo-ref: { kind: Telo.Mount, use: dependency } }
targets:
  - kind: Http.Server
    listen:
      port: !cel "self.port"
    mounts:
      - { path: /, mount: !cel "self.api" }
      - !if
        if: !cel "self.adminPort == self.port"
        then: { path: /admin, mount: !cel "self.admin" }
  - !if
    if: !cel "self.adminPort != self.port"
    then:
      kind: Http.Server
      listen:
        port: !cel "self.adminPort"
      mounts:
        - { path: /, mount: !cel "self.admin" }
```

`port: 8080, adminPort: 8080` runs one server with two mounts; `adminPort:
9090` runs two. `adminPort: !cel "variables.adminPort"`, where that variable is
`type: integer` with no `enum`, is `BRANCH_UNDECIDABLE` at that line: an
integer's domain cannot be enumerated.

### Editor

- The language server publishes each diagnostic with `data.configurations`
  and the labelled message.
- Studio's module graph gets a configuration picker — for a library module
  including its `resources.<input>` presence dimensions — defaulting to each
  dimension's `default:` (a presence dimension to `absent`) and otherwise the
  first value of its domain, and draws the selected configuration. A
  declaration-position choice is one box identified by its name, its
  alternatives keyed by `then` / `else` / case key, and the picker changes the
  box's kind, never its identity. A field-value `!if` shows an "absent"
  alternative. A repeat in a list or a mapping is one row identified by its
  source path (plus its ordinal among repeats of the same source in that
  container); a family is one box with a repeat marker, identified by its name;
  no per-element rows are drawn. None is a new kind of containment.
- Completion inside a family index offers only the valid bindings; rename of an
  `as:` rewrites every index naming it.
- The formatter and studio's YAML round-trip preserve all three tags, their
  mappings and `...` keys where written, writing a declaration-position tag's
  `metadata` first.

### Polyglot

The Rust loader turns the three tags into sentinels identical to the Node
loader's, reads `...` as a plain key, and parses the indexed `!ref` form
through the shared conformance vectors. The Rust kernel evaluates no CEL, so it
refuses a module containing a tag, a splice, an indexed `!ref` or an
`optional:` resource input at load with
the existing `ERR_UNSUPPORTED_MANIFEST_FEATURE`, naming it and its line, as it
refuses `needs:`.

## Part 3 — CRUD over a declared table

Before: `Crud.Resource.table:` is a name string nothing checks against any
declaration, so a model property with no column fails at the first request.

After — both the API contract and the storage stay declared, and are checked
against each other, keeping crud's recorded rule that a shape is declared and
extended, never derived:

- **`table:` also accepts a `!ref` to an `Sql.Table`** — a value branch (today's
  name string) beside a reference branch (`use: dependency`), so every existing
  manifest keeps working. Given a reference, the physical name is the
  referenced table's `table:`. `model:` stays required, and `query` stays
  hand-written on the model.
- **Three rules on `Crud.Resource`**, each `RESOURCE_RULE_VIOLATED` with the
  name in `data.rule` and twinned in its controller under the `ERR_`-prefixed
  name at creation: `CRUD_TABLE_COLUMN_UNDECLARED` (a property of any of the
  four shapes whose column form names no column of the table's row),
  `CRUD_TABLE_TYPE_DIFFERS` (a property's type, `null` aside, differs from its
  column's projected type), `CRUD_TABLE_KEY_DIFFERS` (the row has no `id`
  column, or `read`'s `id` type differs from it).
- **The column form is written once**, as a pure CEL function crud exports,
  `Crud.columnName`: the rules call it, and so does every place crud names a
  column, so the camelCase ↔ snake_case conversion has one home.
- **Two generic widenings of the resource-rule family**, so a rule can see what
  these three must read:
  1. A `resolve:` pointer may cross reference slots, each hop resolved in its
     holder's module, as `x-telo-value-schema-from` locations already do; so
     `resolve: [/model/schemas/read, …]` binds the named shapes, with their
     parents folded in.
  2. A new `project: [<pointer>]` binds a referenced declaration whose kind
     declares `x-telo-schema-projection` as its projected row schema. One
     pointer in both `resolve:` and `project:` is `RESOURCE_RULE_INVALID`.
  The resource-rules guide documents both.

## Part 4 — Webhook verification

Before: a JSON body reaches a route parsed, the exact bytes a provider signed
are gone, and the only way to receive them is a server-wide streaming parser
for `application/json` that changes every other route. CEL has no constant-time
comparison, and no kind on the hub verifies a signature.

After:

- **A route may take its body as bytes.** A route whose `request.schema.body`
  declares `x-telo-type: Telo.Bytes` receives the body as the exact bytes
  received, buffered under `maxBodyBytes`, whatever its content type; no parser
  runs for that route and every other route is unchanged. `http-server`'s
  request-bodies doc gains the row.
- **`crypto`** (new module): `Crypto.Hmac` (sign: message bytes, key,
  algorithm `sha256` | `sha512` | `sha1` → the MAC as bytes) and
  `Crypto.HmacVerify` (message, key, algorithm, expected MAC → `{ valid }`,
  compared in constant time), both invocables, the key marked
  `x-telo-sensitive`. Its code specifier `@telorun/crypto` gives other
  modules' controllers the same constant-time verify.
- **`webhook`** (new module): the `Webhook.Verifier` abstract — an invocable
  taking `{ headers, body }` (`body` a `Telo.Bytes`) and returning
  `{ deliveryId, event?, payload }` (`payload` the parsed JSON body), with
  `throws:` codes `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_TIMESTAMP_EXPIRED` and
  `WEBHOOK_PAYLOAD_INVALID` — plus `Webhook.HmacHeaderVerifier`, the
  provider-neutral implementation (`secret`, `header`, `algorithm`, `encoding`,
  `deliveryIdFrom`). Every verifier compares in its controller through
  `@telorun/crypto`, never in CEL.
- **One module per provider**, as web search is laid out:
  `webhook-github` (`WebhookGithub.Verifier`: HMAC-SHA256 hex in
  `X-Hub-Signature-256`, delivery id from `X-GitHub-Delivery`, event from
  `X-GitHub-Event`) and `webhook-stripe` (`WebhookStripe.Verifier`:
  `Stripe-Signature` `t=` / `v1=` over `<t>.<body>`, a `tolerance` duration
  beyond which a signature is `WEBHOOK_TIMESTAMP_EXPIRED`, delivery id and event
  from the body). Each new module carries `license: MIT` and its own
  `LICENSE`.

## Blueprints

Three new blueprints, each with an `example/` and `tests/`:

- **`blueprints/scheduled-jobs-app`** (Part 2): a map of jobs, one
  `Scheduler.Cron` member each, started in order.
- **`blueprints/crud-app`** (Part 3): a connection and a map of collections
  keyed by their plural, each `{ table: !ref, model: !ref, singular }`; one
  `Crud.Resource` per entry, every one mounted on one server.
- **`blueprints/webhook-app`** (Part 4): a key/value store for deliveries and a
  map of webhooks keyed by path segment, each `{ verifier: <an inline
  verifier>, handler: !ref … }`. Each webhook is one `POST /hooks/<key>` route
  taking its body as bytes, which verifies, then runs `Idempotency.Once` keyed
  on the verifier's `deliveryId`, then calls the handler with the payload;
  `WEBHOOK_SIGNATURE_INVALID` and `WEBHOOK_TIMESTAMP_EXPIRED` answer `401`,
  `WEBHOOK_PAYLOAD_INVALID` answers `400`, an accepted or redelivered event
  answers `202`.

## Diagnostics

| Code | Reported at | Meaning |
|---|---|---|
| `REPEAT_OUTSIDE_TEMPLATE` | the tag | `!for-each`, or a `...` splice of one, outside a template body |
| `REPEAT_POSITION_INVALID` | the tag or the `...` entry | a `!for-each` at a field value, or a `...` key whose value is not a `!for-each` or a list of them |
| `REPEAT_SHAPE_INVALID` | the tag | the tag's mapping does not fit its form: an unknown or missing key, `key:` outside a splice or missing at one, `metadata` missing at a declaration position or present elsewhere, `name:` outside a step list |
| `REPEAT_EMIT_INVALID` | the `emit:` | a declaration carrying `metadata` at a list position or a splice; a sequence at a declaration position or in a named step repeat; an `!if` with no `else:` in a family's `emit:`; an emitted step carrying `name:` |
| `REPEAT_SOURCE_INVALID` | the definition | `in:` is not a bare `self.<path>` / `<binding>.value.<path>`, or its schema is not an array or a map |
| `REPEAT_COMPUTED` | the consumer's key or the declaration | the source collection or a `key:` is not literal, or crosses into another module's declaration |
| `REPEAT_KEY_INVALID` | the `key:` | does not type to `string`, throws, or calls a forbidden function |
| `REPEAT_KEY_DUPLICATE` | the consumer's element | two elements, or an element and a literal or another splice, emit one key |
| `REPEAT_NUMERIC_KEY` | the consumer's key | a map source has, or a splice emits, an integer-like key |
| `REF_MEMBER_INVALID` | the `!ref` | a malformed indexed reference, a family without an index, an index on a name that is not a family, the wrong depth, a binding out of scope or iterating another source, the wrong member, an alias with an index |
| `BINDING_NAME_RESERVED` | the `as:`, the tag or the key | a loop name reused by a nested loop, bound by an emitted item's kind, used as a named binding, or a CEL keyword, global or module-call receiver |
| `BRANCH_POSITION_INVALID` | the tag | `!if` / `!switch` as a file's first document, in a module doc outside `targets:`, or in a kind document outside its template body |
| `BRANCH_SHAPE_INVALID` | the tag | the tag's mapping does not fit its grammar: an unknown or missing key, `metadata` missing at a declaration position, or `metadata` anywhere else |
| `BRANCH_UNDECIDABLE` | the open value | a condition reads an input other than through one of the three projections, a value that is not literal, or crosses into another module's declaration |
| `BRANCH_CONDITION_INVALID` | the condition | does not parse or type-check, throws, yields the wrong type, or calls a forbidden function |
| `BRANCH_CASE_KEY_INVALID` | the case key | a case key is not a value of the selector's type |
| `BRANCH_NOT_EXHAUSTIVE` | the `!switch` | a configuration, or a closed domain the definition reads, selects no case and there is no `default:`; or the domain is open and there is no `default:` |
| `BRANCH_CASE_UNREACHABLE` | the case (warning) | no configuration, and no value of the closed domain, selects it; the dead branch of a constant condition |
| `BRANCH_CASE_INVALID` | the branch | at a declaration position, a branch is not one unnamed resource declaration (or a nested choice or family whose branches are), or branches differ in arity |
| `DEFAULT_INVALID` | the `default:` | (extended) `default: null` on a `ports:` entry |
| `RESOURCE_INPUT_OPTIONAL_REFERENCED` | the `!ref`, labelled with the absent configuration; at an omitting importer's `imports:` entry | a `!ref` to an optional resource input outside a branch proving it present |
| `SHARED_LIBRARY_CONFLICT` | both imports | (extended) imports of a shared library disagree on whether an optional input is supplied |
| `DEPENDENCY_CYCLE` | the import | (extended) a resource supplied to an import reaches an export of that same import through hard edges |
| `CRUD_TABLE_COLUMN_UNDECLARED` / `CRUD_TABLE_TYPE_DIFFERS` / `CRUD_TABLE_KEY_DIFFERS` | the `Crud.Resource`, as `RESOURCE_RULE_VIOLATED` | a model shape disagrees with the referenced table's row |
| `RESOURCE_RULE_INVALID` | the rule | (extended) one pointer in both `resolve:` and `project:` |

Every error has its `ERR_` twin — at definition registration for a definition's
defect, at creation for a consumer's value, at load for a document — pinned in
`tests/check-run-agreement.yaml` (the CRUD rules in crud's own `tests/`).
`REPEAT_UNREACHABLE` is not introduced.

## Housekeeping

- **One expansion, read by both halves.** The analyzer owns the expansion and
  the configuration enumeration; the kernel reuses them, so the two cannot
  disagree about what a manifest expands to. Nothing in either names a kind.
- **Floors.** Every module whose own `telo.yaml` writes one of the tags, an
  `as:`, a `...` splice, a family, an indexed `!ref`, a step repeat, a
  non-`!ref` item in a templated `targets:`, `default: null` on a `variables:`
  / `secrets:` entry, `optional: true` on a Library `resources:` entry, or a
  rule's `project:` / reference-crossing `resolve:`
  (crud), declares `requires: telo:` at the release that ships this, as the
  surface generator reports it, verified by running the previous published CLI
  against it.
- **Releases.** A changeset for the telo version line (analyzer, templating,
  kernel, CLI, language server, ide-support, SDK); `telo release` fragments for
  `crud`, `http-server`, the new `crypto`, `webhook`, `webhook-github` and
  `webhook-stripe`, and each new blueprint.
- **Docs.** The templated-definitions guide (all three tags and their forms,
  the binding record, splices, families, step repeats, identity); a new guide
  on configurations (the three projections, crossings, narrowing, absence,
  derived requirements, ports under runners, and "a backend is chosen by the
  environment through the presence of its own input"); the
  application-arguments spec (`requiredWhen`, `--help`); the needs guides
  (presence, per-configuration requirement, the report's `dimensions` and
  `requiredWhen`); the library-resource-inputs guide (optional inputs, the
  fallback pattern, ownership, and the collector rule, naming the graph
  stores' bookkeeping tables as a registered member that is declared rather
  than defaulted); `modules/sql/docs/declarative-schema.md` (a module's tables
  are listed by the application's schema); the root `CLAUDE.md`'s and the
  analyzer guide's `Telo.Library` `resources` bullet; the kernel guide's
  import-controller expansion and the hard edge through an import; the
  resource-rules guide (`project:`, crossing `resolve:`);
  the analyzer guide's template, reference-form, scope-member and CEL-scope
  sections (the "a `with:` scope member gets none" sentence goes); the kernel
  guide's load order; the root `CLAUDE.md`'s reference sentence (the indexed
  form); `blueprints/README.md`; the docs and README of `crud`, `http-server`,
  `crypto`, `webhook`, `webhook-github` and `webhook-stripe`.
- **Benefits ledger.** `docs/guides/what-you-get.md` gains, in the same change:
  one application on several backends chosen by its environment; inputs asked
  for only when the chosen setup uses them; verified webhooks, with signatures
  checked in constant time and redeliveries run once; CRUD routes checked
  against their table before the app runs; and, for module authors, templates
  that turn a consumer's list into resources, routes, map entries and steps.
- **Authoring agent.** The primer gains the three tags and their forms, the
  binding record, splices, families and the indexed `!ref`, absence, the
  decidability rule (including "a decided value may read through a reference
  into a declaration of your own module"), the backend-by-environment pattern,
  "inline when used once, a declaration-position choice when named", optional
  resource inputs with a library-owned fallback, the rule that only a
  collector lists its members, and the webhook verifiers, in the same change.

## Verify

**Part 2 — language**

- ScheduledJobs with three jobs boots; all three crons hold the app and fire;
  a span from the `nightlyReport` member carries
  `telo.resource.name: crons['nightlyReport']`, and after a reload the same
  member reappears under the same name.
- The routes example produces ONE `Http.Api` and one OpenAPI document with a
  POST and a GET per hook, interleaved per hook, and one POST per table
  operation at `/<table>/<op>`; two routes whose `inputs:` read
  `hook.value.secret` each receive their own; inserting a literal route before
  a repeat leaves every emitted route's generated identity unchanged.
- Two nested loops both left as `each` are `BINDING_NAME_RESERVED` at the
  inner tag; `each.key` over a list source is `CEL_UNKNOWN_FIELD`.
- The splice example emits `id` plus one column per field; a consumer field
  `id`, and two elements emitting one key, are `REPEAT_KEY_DUPLICATE` at the
  consumer's element; `...: { a: 1 }` in a body is `REPEAT_POSITION_INVALID`.
- A family member shared by a route and a `targets:` entry through
  `!ref stores[each.key]` boots with one member per element; `!ref stores`
  with no index, and `!ref stores[x.key]` where `x` iterates a different
  source, are `REF_MEMBER_INVALID` at the definition.
- A named step repeat invoking `!ref crons[each.key]` runs once per job in
  order, and a later step reads `steps.runs[each.key].result`, typed.
- A kind with `port` and `adminPort` runs one server with two mounts when they
  are equal and two servers when they differ.
- The supervisor example passes `licenseKey` to the child only when
  `LICENSE_KEY` is set; the same `!if` on a `required` field is
  `SCHEMA_VIOLATION` labelled `(when secrets.licenseKey is absent)`.
- A fixture app with an `enum` dimension choosing between two in-memory
  fixture backends under one name starts on either by env; `telo check`
  reports a typo inside the branch that is not the default, labelled with its
  configuration; the unchosen kind's controller never loads (no
  `ControllerLoading` event for it). A value its `enum` does not list is
  `ERR_MANIFEST_VALIDATION_FAILED` naming the variable and its allowed values,
  before any resource is created.
- The model-provider example, over two fixture models: only `OPENAI_API_KEY`
  set gives the first, only `ANTHROPIC_API_KEY` the second, both the first;
  neither is `ERR_MANIFEST_VALIDATION_FAILED` naming `anthropicApiKey` only;
  `--help` and `telo module manifest --json` report its `requiredWhen`.
- A `Telo.Url` secret declaring `scheme: { enum: [a, b] }` drives a `!switch`
  on its `scheme`; a URL with scheme `c` is refused at load naming the secret
  and never printing it; a condition reading its `host` is
  `BRANCH_UNDECIDABLE`.
- A variable declaring `type: string, default: null` read unguarded outside a
  branch proving it present is `CEL_NULLABLE_ACCESS`, and read inside one is
  not; `default: null` on a port is `DEFAULT_INVALID` from `telo check` and
  refused at load.
- `if: !cel "self.a.mode == 'x'"` with `a` a `!ref` to a literal `mode: x`
  selects its branch, and `mode: !cel "variables.mode"` (an `enum`) makes it a
  dimension; `in: !cel "table.value.columns"` over a list of table `!ref`s
  emits per table; a `!ref` to an imported library's instance in a condition
  is `BRANCH_UNDECIDABLE` at the reference; `if: !cel "module.version ==
  '1.2.0'"` is decided, its dead branch warned.
- A library's `!switch` over `self.mode` declared `enum: [a, b]` with no `b`
  case is `BRANCH_NOT_EXHAUSTIVE` from the library's own `telo check`; one over
  an open `type: string` with no `default:` is the same; a consumer writing
  `mode: c` gets `SCHEMA_VIOLATION` at its key and nothing else.
- A condition reading a `variables` entry declared `type: string` is
  `BRANCH_UNDECIDABLE`; `jobs: !cel "variables.jobs"` is `REPEAT_COMPUTED`; a
  map source keyed `"2024"` is `REPEAT_NUMERIC_KEY`; a boolean `!switch` with a
  case `yes` and an integer one with a case `01` are `BRANCH_CASE_KEY_INVALID`;
  `in: !cel "self.name"` on a string field is `REPEAT_SOURCE_INVALID`; an
  `emit:` that does not fit its list's item schema is reported at the `emit:`
  field.
- A typo inside a nested `emit:` (`crno:`), inside a family's `emit:` and
  inside a branch of a template is reported by `telo check` on the template
  alone, with no consumer.
- A declaration-position choice `db`: renaming it in the editor finds exactly
  one declaration site; a plain `db` beside it is `DUPLICATE_RESOURCE_NAME`
  with no `data.configurations`; a typo in a case nobody selects is reported
  at `cases.postgres.<typo>`, labelled `(when variables.dialect is postgres)`;
  the module graph shows one `db` box in every configuration, whose row
  identity survives switching the picker and adding a case.
- A `Sql.Query` outside every branch, holding `connection: !ref db` where `db`
  chooses between two connection kinds and one is refused at that slot, is
  reported labelled with that configuration only.
- A `Run.Sequence` with a declaration-form `!if` named `db` in `with:` runs on
  either backend by environment, and a typo in its unchosen branch is reported
  labelled with its configuration.
- `--- !if` as a file's first document is one `BRANCH_POSITION_INVALID` and no
  missing-module-doc diagnostic; a tag at an `imports:` entry, a `variables:`
  entry and a `Telo.Definition`'s `schema:` are each `BRANCH_POSITION_INVALID`;
  a tag as an Application `targets:` item and inside a template body's
  `resources:` entry is accepted; `metadata` on a value-position tag is
  `BRANCH_SHAPE_INVALID` and `metadata` inside a branch is
  `BRANCH_CASE_INVALID`.
- A runner session assigns every declared port in every configuration,
  including an admin port whose server is not chosen.
- Every error code above has its `ERR_` twin pinned in
  `tests/check-run-agreement.yaml` at the declaring library and at a silent
  consumer.
- The `...` splice and the indexed-`!ref` conformance vectors pass in both
  loaders, and both produce identical sentinels for every tag form; a splice
  round-trips unchanged through the Node parser, the Rust parser, studio's
  save and the formatter, and yaml-language-server opens it with no error in
  its 1.1 and 1.2 modes.
- The analysis time of an app combining the database and model-provider
  examples is recorded at one, two and four configurations, and only the
  whole-application checks and the per-resource checks of resources whose
  reach varies grow with the count; a family of 1,000 members analyses in time
  linear against 10 and 100.

**Part 3 — CRUD**

- A model whose `createdAt` has no `created_at` column in the referenced table
  is `CRUD_TABLE_COLUMN_UNDECLARED` from `telo check` and refused at creation;
  a type mismatch and a missing `id` give the other two rules; a matching pair
  serves its list / read / create / update / delete routes.
- A `Crud.Resource` with a string `table:` behaves exactly as before.
- One pointer in both `resolve:` and `project:` is `RESOURCE_RULE_INVALID`.
- `crud-app` over two collections creates both tables before the server
  starts and serves both resources.

**Part 4 — Webhooks**

- A route declaring a `Telo.Bytes` body receives the exact bytes of a JSON
  request, while a sibling route on the same server still receives it parsed.
- `Crypto.HmacVerify` accepts a correct MAC and refuses one differing in its
  last byte.
- `webhook-app` with a GitHub and a Stripe webhook accepts a correctly signed
  delivery (`202`), runs its handler once when the same delivery is sent twice,
  answers `401` for a bad signature and for a Stripe timestamp beyond the
  tolerance, and `400` for an unparseable body.

**All parts**

- The previous published CLI refuses each adopting module with its `requires:`
  stripped, and reports `MODULE_REQUIRES_NEWER_RUNTIME` once it is restored.
