---
status: in-progress
priority: high
depends-on: []
packages: [analyzer/nodejs, analyzer/rust, analyzer/check-conformance, kernel/nodejs, kernel/rust, templating/nodejs, templating/rust, templating/cel-conformance, templating/tag-conformance, cel/nodejs, cel/rust, sdk, cli/nodejs, modules, apps/authoring-agent, apps/hub, examples, starters, tests, docs]
refinement: ready
tracking: feat/templating-follow-ups-2
---

# Templating follow-ups: finish the analysis over configurations, close the template-body gaps

## Problem

A *configuration* is one assignment of the values a manifest's choices read
(`variables.flag1 = true`, a need present or absent). `telo check` gives each finding a
*presence condition* — the configurations it holds in — and is meant to judge every check
once over all of them, at a cost that grows with the number of choices and never with the
number of configurations.

Most of the analysis works that way: CEL, schema and own checks, resource and referrer
rules, references, the call graph and the passes over it, the need table, texts, the
document-level stages, and every read of a named shape (a `Telo.JsonSchema` / `Telo.Type`
declaration, which may itself be declared under a choice or hold one). What remains:

- **Cost grows superlinearly in the number of declarations.** A templated kind's
  `!for-each` over 1,000 items checks 2.9× slower than before the analysis over all
  configurations landed, and 1,000 choice sites over two dimensions run 1.9× slower.

- **A chain of named shapes multiplies.** A check that reaches a named shape reads it and
  every shape it references onward, whole, so its cost is the product of the classes along
  the chain: on a resource writing values through k varying shapes the counters below
  double per shape, and the check runs out of memory at k = 8.
- **A few checks still run once per configuration**, and the per-configuration loop and
  the unreachable-branch loop still exist beside the analysis over all configurations.
- **Template bodies are checked less strictly than ordinary declarations**: some mistakes
  inside a body, or in what a consumer passes to one, are not reported, and some values in
  a body are typed in a way that does not match what the kernel hands them at run time.
- **CEL reads below a binding's first level are not type-checked**: an operand read from
  `self.a.x`, `inputs.order.total` or a module call's result is untyped to the checker, so a
  wrong-typed operation passes `telo check` and fails at run time.

## Constraints

None.

## Surface

**Added**

- `schemaDependencies` — on a check result of `@telorun/cel` (and in the CEL conformance
  rows): the schema nodes the check's verdicts and result type read, each the document the
  host handed over plus a JSON Pointer; a namespace function's result may be declared as a
  JSON Schema document, read through the environment's resolver with its reads listed; and
  the engine answers whether two documents agree on a listed node's own type.
- `SCHEMA_IN_PLACE_CYCLE` — a schema whose references come back to the node they left at
  the same data position through in-place keywords alone; refused where it is declared,
  before any value is validated against it.
- `ERR_SCHEMA_IN_PLACE_CYCLE` — the kernel's refusal of such a definition or named shape at
  registration.
- `schemaNode` / `resultOrigins` — on a check result of `@telorun/cel`: the schema node a
  refused member, operand or nullable read was judged at (`{ document, pointer }`, as a
  `schemaDependencies` entry is), and each place the check's result may have come from, with
  its source range, its CEL type, and the schema node its value is an instance of, where it
  is one.
- `CEL_SCHEMA_UNJUDGED` — a warning at a schema node a CEL binding is typed from that the
  type checker cannot read; CEL reads beneath it are not type-checked. Not reported for
  `not` whose subschema constrains only values or excludes whole types, for `if` / `then` /
  `else`, for `patternProperties` (under `allOf` included), nor for a tuple written as
  `items` with `additionalItems` or as `prefixItems` with `items`; reported for
  `prefixItems` beside `additionalItems` or beside an array `items`, and for a
  `patternProperties` pattern RE2 cannot read.
- `additionalFields` — on `@telorun/cel`'s record type: the type of every member the record
  does not declare (absent: closed).
- `absentFields` — on `@telorun/cel`'s record type, open or closed: the member names whose
  schema admits no value (`false`, `not: {}`, `not: true`), read as no member — refused
  except to a presence test, which reads it as absent — rather than typed by
  `additionalFields`; dropped when empty, and compared by record equality and the
  environment digest.
- `fieldEnums` — on `@telorun/cel`'s record type: per declared field, the finite set of
  values its schema admits; absent rather than empty.
- `assumptions` — option on `@telorun/cel`'s check: guarding conditions, each with `holds`
  and `rebound`; and a field of a `templating/cel-conformance/` row.
- `patternParts` — on `@telorun/cel`'s record type: the `patternProperties` a member no
  `properties` entry declares is read by, one part per schema part declaring them: its
  `fields` (each entry in written order, its pattern read as RE2 and the type of every
  member whose name it matches, absent where it admits no value) and its `additionalFields`
  (the type the part gives a member another part's pattern matches and none of its own does;
  absent where the part is closed or open to anything). Such a member, where some part's
  pattern matches it, is the meet over the parts of each part's matching entries, else its
  `additionalFields`. A record read from one schema node has one part with no
  `additionalFields`; parts with the same pattern texts are one part — their entries met by
  text, their `additionalFields` the meet of those carrying one — except parts whose
  `additionalFields` cannot meet, which stay apart; parts with no `additionalFields` are one
  part; and a part left alone carries no `additionalFields`. Absent when empty; compared by record equality and the environment
  digest.
- `prefixElements` — on `@telorun/cel`'s list type: the type of each leading position
  (absent: a plain list).
- `additionalElements` — on `@telorun/cel`'s list type, carried only beside
  `prefixElements`: the type of every element past them (absent: no element past them).
- `UNION_EXPANSION_LIMIT` — exported by `@telorun/cel`: at most 64 combinations of union
  argument types are resolved for one call.
- `ERR_SCHEMA_TYPE_REF_UNRESOLVED` — raised when an import initializes, for an entry naming a
  shape its configuration does not declare.

**Changed**

- `MODULE_PATH_OUTSIDE_RESOURCE` / `INCLUDE_OUTSIDE_RESOURCE` — no longer reported at a
  `Telo.Import`'s `variables:` / `secrets:` / field-by-field `needs:`, in any of the three
  forms.
- `HOST_PATH_UNTYPED_SOURCE` — no longer reported for `!module-path`.
- `MODULE_PATH_NOT_FOUND` / `INCLUDE_FILE_NOT_FOUND` / `HOST_PATH_ENTRY_MISMATCH` /
  `HOST_PATH_CONTENT_MISMATCH` / `ERR_MODULE_PATH_NOT_FOUND` — now also reported at an
  import's inputs.
- `IMPORT_ALIAS_SHADOWS_CONTEXT` — no longer reported for a `Telo.Import` declared as a
  scope member; where several kinds put one alias in scope, the message names the kind of
  the first such declaration in source order.
- `CEL_TYPE_ERROR` / `CEL_UNKNOWN_FIELD` / `CEL_NULLABLE_ACCESS` — decided by the type
  checker at every depth of a binding, so an operand or argument read below a binding's
  first level is type-checked (`self.a.x + 1` with `x` a string), at every CEL site of a
  template body and of a `base:` mapping, and through a module call whose `params[].schema`
  / `returns.schema` nests a `$ref` to a named shape; a member refused at depth is reported
  once.
- `CEL_TYPE_ERROR` (in `@telorun/cel` / `telorun-cel` and every host) — no longer reported
  for a conditional or list whose parts differ by null or where one includes the other, for
  `==` / `!=` / list `in` between a nullable value and its non-null type, or for a value a
  guard proved non-null; a value forwarded to a slot that may be null and otherwise fits is
  worded as needing a guard.
- `CEL_NULLABLE_ACCESS` — also reported for an unguarded dereference of a chain rooted at a
  comprehension variable or `cel.bind` name; a guard's proof does not cross a rebinding;
  `xs.map(e, p, t)`'s transform is guarded by `p`.
- `CEL_UNKNOWN_FIELD` — a member only some shapes of a union declare is one finding per read
  naming `.?`; `has(x.m)` guards a read of `x.m`.
- `CEL_TYPE_ERROR` (in `@telorun/cel` / `telorun-cel` and every host) — also no longer
  reported for `in` over a record admitting undeclared members, `==` / `!=` against `null`,
  `==` / `!=` / `in` whose sides share a type, a call or operator over a union each member
  of which an overload takes, a type parameter whose arguments join, a value narrowed by
  `type(x) == …`, a comprehension over a union of lists and maps; still reported naming the
  member no overload takes; reported for a literal index past a closed tuple, and for a
  misuse of an element past a tuple's positions typed by its `additionalItems` / `items`
  schema.
- `CEL_UNKNOWN_FIELD` — an undeclared member of an object with a schema
  `additionalProperties` is typed by that schema; a member declared `false`, `not: {}` or
  `not: true`, alone or as one half of an `allOf`, is reported wherever it is read other
  than by presence.
- `CEL_UNKNOWN_IDENTIFIER` — reported for `resources` / `ports` read in a `Telo.Import`'s
  `variables:` / `secrets:`, naming the configuration-only contract (was
  `CEL_UNKNOWN_FIELD`).
- `HOST_PATH_UNTYPED_SOURCE` / `HOST_PATH_RELATIVE` / `HOST_PATH_ENTRY_MISMATCH` /
  `HOST_PATH_CONTENT_MISMATCH` — also reported at a `Telo.Import` declared as a scope
  member, at its `variables:` / `secrets:`, labelled by its holder's presence.
- `BRANCH_CASE_INVALID` — no longer raised for a `Telo.Import` branch at a scope-member
  position.
- `IMPORT_UNRESOLVED` / `INVALID_IMPORT_SOURCE` / `INVALID_IMPORT_TARGET` — now also
  reported for a scoped import beneath a choice.
- `CEL_UNKNOWN_FIELD` / `CEL_NULLABLE_ACCESS` / `CEL_TYPE_ERROR` /
  `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED` — no longer reported for a read a discriminant
  test or an enclosing step guard proves, nor for a conditional, aggregate or type parameter
  joining a union with a member kin to one of its members; the union-member finding also
  names the discriminant test where one exists.
- `BRANCH_POSITION_INVALID` — raised by the loader at a `Telo.Import`'s `kind` / `metadata`
  / `source` / `integrity` in all three forms, no longer at its inputs, worded with the
  import's alias and source.
- `BRANCH_UNDECIDABLE` — also reported for a choice reading an input whose `variables:` /
  `secrets:` entry reaches a named shape another choice varies, naming the input and the
  shape.
- `SCHEMA_TYPE_REF_UNRESOLVED` — also reported at an import supplying a value for, or reaching
  a `default:` of, a library entry whose shape the import's configuration leaves undeclared.
- `SCHEMA_VIOLATION` — at an import, judged against that import's own variant of a library
  shape.
- `TEMPLATE_TARGET_MISMATCH` — also reported where the dispatched entry kind's
  `inputType` is derived from the entry (`x-telo-value-schema-from`,
  `x-telo-schema-projection-from`).
- `REFERENCE_KIND_MISMATCH` — also reported at a reference slot inside a template body's
  `resources:` entry, and at a contract or signature `!ref` (`inputType`, `outputType`,
  `params[].schema`, `returns.schema`) naming a declaration that is not a named shape; the
  kernel refuses the latter as `ERR_REFERENCE_KIND_MISMATCH`.
- `RESOURCE_RULE_INVALID` — no longer reported for a rule that fails reading a field the
  entry receives from a schema `default:` (at any position resource validation fills one),
  nor for one reading a property its subject lacks although the subject's kind requires it.
- `self` (inside a template body) — also holds the `default:` values declared beneath a
  `$ref` or an `allOf` member of the kind's schema, as the resource's validation fills them.
- `SCHEMA_COMPILE_ERROR` — no longer reported for a kind whose `schema:` references its
  library's own named shape varying under the library's inputs.
- `CEL_IN_NON_EVAL_FIELD` — no longer reported at a consumer's field whose eval mode such a
  shape varies.
- `variables.<name>` / `secrets.<name>` — inside a library, an entry typed `Text` or
  `Message` reads as a `TextRecord` attributed to the importer that supplied it.
- `TEXT_ARGUMENT_COMPUTED` / `ERR_TEXT_ARGUMENT_COMPUTED` — also reported at an import's
  text input.
- `Telo.Library` `variables:` / `secrets:` — each entry is validated as a JSON Schema
  (`SCHEMA_VIOLATION` at an entry that is not one).
- `Telo.Application` `variables:` / `secrets:` — each entry is a JSON Schema position, so a
  `$ref` to a recursive fragment such as `Text` checks and loads.
- `Telo.Builtins` archive — the two module documents' entry schemas re-rendered.
- `SHARED_LIBRARY_CONFLICT` / `ERR_SHARED_LIBRARY_CONFLICT` — a text parameter is compared
  by its settled record, the importer's `lang:` included.
- `ERR_HOST_PATH_ENTRY_MISMATCH` / `ERR_HOST_PATH_CONTENT_MISMATCH` — also raised when an
  import initializes, for a path its `variables:` / `secrets:` hands a library input
  declaring `entry` / `mediaType`.
- `REPEAT_OUTSIDE_TEMPLATE` / `ERR_REPEAT_OUTSIDE_TEMPLATE` — raised by the loader for
  `!for-each` at a `Telo.Import`'s `kind` / `metadata` / `source` / `integrity`, and for a
  `...` splice at an import's own top level, in all three forms, worded with the import's
  alias.
- `ERR_NEED_UNMET` — also raised for a library need that the taken option of a choice at an
  import's `needs:` leaves unsupplied (the load's need table is the running configuration's).
- `telo needs report` — lists a need an option of an import's `needs:` leaves to the
  environment, `required when` that option is taken.
- `ERR_MESSAGE_SYNTAX_INVALID` / `ERR_MESSAGE_PLURAL_CATEGORY_INVALID` /
  `ERR_MESSAGE_SOURCE_LANGUAGE_MISSING` — also raised when an import initializes, for a
  library text parameter's value or `default:`.
- CEL type text (`typeName` on a check result, every diagnostic naming a type): written whole
  up to 64 type nodes, then cut with `...`.
- `ResolvedCall.argumentTypes` now holds types, and the text moves to `argumentTypeNames`.
- `NamespaceListing.functions` lists each function as `{ declaration, resultType? }`:
  `declaration` is the text that was `functions`' entry — the signature, or `name(…): <result>`
  cut past its bound — and `resultType` is the CEL type of a result declared as a JSON Schema,
  present exactly then; the environment digest reads `resultType` structurally, and
  `telorun-cel`'s listing carries the same entry shape.

**Removed**

- `open` — on `@telorun/cel`'s record type, replaced by `additionalFields`.

## The oracle and the measurements

- **The differential** — per configuration, the conditioned findings equal a plain
  analysis of that configuration's expansion; the **definition differential** does the
  same per template-definition variant. Every new fixture is recorded first on the code it
  replaces.
- **The parity oracles** — the relation census against each configuration's enumeration
  (`relation-sites`), the call graph over every configuration against each configuration's
  own (`conditioned-call-graph`). Both are deleted with the loops in part 3, after which the
  differential alone judges.
- **The corpus dump** — every manifest in the tree analysed, compared byte for byte before
  and after a change; a change lists every differing finding.
- **The cost fixtures** — **V** (N steps, step k a `value: !if variables.flagK` reading the
  one before), **W** (V's steps in one `try:`), **S** (N jobs, each declared only when its
  flag holds, started from an `!if` item of `targets:`, with a call cycle through two
  choices), **T** / **Tn** (V's steps written by a consumer of a templated kind, Tn beneath
  a sequence holder).
- **The chain fixture C(k)** — k named shapes `S1 … Sk`, each `schema: !if variables.flagI`
  whose `then` declares a reference slot `x` (`x-telo-ref: { kind: Telo.Invocable, use:
  call }`) and whose `else` declares `x` as a plain object, each holding `next: { $ref:
  telo://Self/S<i+1> }`; one kind `Route` whose `s` `$ref`s `S1`; one resource writing an
  inline `Telo.Value` at every `x` down the chain. Today, at k = 1/2/3/4: 2/4/8/16
  normalizations of the resource, 7/15/31/63 schema-door evaluations, 6/15/35/79
  relation-door evaluations; k = 8 runs out of memory.
- **The feature-cost sweep** (`benchmarks/feature-cost/`, nightly on `main`) — the
  baseline is the last nightly before the analysis over all configurations landed,
  `96e82c70`, on the Intel Xeon 6975P host, warm, median: `forEachIterations` `telo check`
  2392 ms at N = 100 and 5127 ms at N = 1000; `choiceCount` `telo run` 1081 ms at N = 100
  and 2394 ms at N = 1000. A comparison is made only between runs on the same host model:
  the baseline `96e82c70` is rerun on the host the comparison is made on (built CLI, warm,
  median of 7), and the nightly figures stay as that host's reference.

Every part keeps the differential green and the corpus dump byte-identical apart from what
it lists, each listed change with a fragment line.

## 0. Cost grows linearly in the number of declarations

- **Before:** since the analysis over all configurations landed, two sweep features grow
  superlinearly in N. `forEachIterations` (one templated kind whose body is a `!for-each`
  over N items, no choices) checks in 14695 ms at N = 1000, 2.9× the baseline, and only 6%
  over it at N = 100. `choiceCount` (N resources under `!if` / `!switch` over two
  dimensions) runs in 4603 ms at N = 1000, 1.9× the baseline, while its `telo check`
  became 25% faster. Deleting the configuration loops cannot recover either: the added
  cost exceeds the whole analysis time before the change. Regression issues #854 and #855.
- **After:** the stage that grows superlinearly in the number of `!for-each` items, and the
  one that grows superlinearly in the number of choice sites over fixed dimensions on the
  load a run performs, are found by a profile at N = 1000 and made linear.
- **Verify:**
  - `forEachIterations` `telo check` and `choiceCount` `telo run` at N = 100/500/1000/2000:
    each interval's time per added item, (t(N₂) − t(N₁)) / (N₂ − N₁), is at most 1.25 × the
    first interval's.
  - `choiceCount` `telo run`, against the baseline on the same host: t(1000) at most the
    baseline's, and its per-item time (t(1000) − t(100)) / 900 at most the baseline's.
  - `choiceCount` `telo check` stays at or below its time before this part.
  - The profile's per-stage table at N = 100 and N = 1000 recorded in the change's report.
  - The per-item cost `forEachIterations` `telo check` still carries over the baseline is
    part 3's bar and work.

## 1. Named shapes are read one hop at a time

### 1a. The chain gate

- **Before:** nothing in the tree measures C(k); the numbers above come from a probe.
- **After:** the first change of this part adds an in-tree counter test over C(k) at
  k = 1/4/8/16. It asserts the After numbers of 1b and 1c over the stages over all
  configurations: each case ends when the analysis's first configuration or dead-branch run
  starts, until part 3 removes that stop. It fails only on counts — a case exceeding the
  doubling bound is stopped there — and has no wall-clock budget. It is red until 1c lands
  and stays as the gate.
- **Verify:** the test fails on the tree before 1b, printing today's numbers.

### 1b. A slot a varying shape declares is written into the normalized union once

- **Before:** a reference slot that only some classes of a varying named shape declare is a
  cut point of the declaration holding a value there. Normalization decides every cut point
  at the key's witness, so a key part carries the decided combination and one declaration
  is normalized once per combination (2^k on C(k)).
- **After:** a cut point is written into the normalized union as a two-option node, as a
  written choice is: under the site's condition (a class declaring the slot ∧ that class
  reached, OR over the classes) the inline value is extracted and the slot holds a
  reference to it; under its negation the value stays as written. A declaration is
  normalized once per content, a part never carries decided cut points, and normalization
  never runs at a decided-reach witness. Decided reach stays only where one configuration is
  consumed: the differential, and the configuration runs until part 3.
- **Verify:** C(k): one normalization of the resource at k = 1/4/8/16, counted up to the
  start of the first configuration or dead-branch run. Seeded fault — a part
  carrying the decided cut-point vector — makes the count grow with k. Differential green.

### 1c. A check reads only the named shapes it names directly

- **Before:** own-check keys, relation keys (the shapes in force at the anchor and at each
  read place), the contract shapes of a resolved target or scope member, a CEL site's name,
  callee and annotation reads, and module-call signatures each read every named shape they
  reach, whole and transitively, so a key's classes are the product of the classes along
  the reach path. A value checked against a slot schema that lies beneath a named shape
  folds the reach closure into one class.
- **After:** a check reads only the named shapes it names directly — the contract shapes of
  its resolved target or scope member, the shapes in force at its anchor, those at its read
  places, those its annotations name — each through the named-shape reader as that one
  shape's own class. A named reference inside such a shape is answered as a reach edge (the
  shape's id), never by the inner shape's content. What a check needs beneath a reference is
  a sub-verdict, memoised by (shape, class, position — the remaining member path, or the CEL
  type fitted there — and, for a schema sub-verdict, the decision summary of each carve its
  judgement reads), or for a comparison by (position pair, class pair), each memo entry one
  judgement, joined to the check by the one condition-labelled reach graph and its
  fixpoint, so its finding holds under class ∧ reach. A CEL chain through k nested shapes is judged hop by hop: a sum, not
  a product. A slot schema beneath a named shape is the reader's census answer per class. A
  missing shape is skipped, since `CONTRACT_TYPE_NOT_FOUND` / `SCHEMA_TYPE_REF_UNRESOLVED`
  report it. A finding's text is the plain driver's; where it differs per position it is
  split, naming the first failing position in written order under the negation of the
  earlier ones. The fold of the reach closure is deleted with no fallback, and so is the
  per-shape split that today keeps a `Telo.Function` whose `returns.schema` names a varying
  shape from crashing — replaced by this read, not dropped. Beneath a keyword that relates
  members (`anyOf`, `oneOf`, `not`, `if` / `then` / `else`, `dependentSchemas` /
  `dependencies`, `contains`, tuple `items` / `prefixItems`) a reference is a schema carve.
  Its sub-verdict carries a summary — what a relating keyword reads of it — in two parts:
  the decision part (the validator's verdict on the class there, whether the class is a
  candidate for the value's JSON type, its `const` / `enum`-constrained places and required
  members, whether it reports anything, and each finding it reports at its own position or
  a constrained place, as keyword, relative place and the outcome of the union reporting
  it) and the text part (those findings' params and phrases, its own class's alone,
  referring to the summaries of the carves inside it rather than copying them). The carve
  stands in as a custom validator keyword, `schemaCarve`, asked at each data position it
  applies at, answering the decision part's verdict and handing the summary to the union
  judge, so `anyOf` / `oneOf` and the validator's own keywords read one carve alike. It is
  registered only on the validators a key's door judges with, and it answers only for the
  stand-in documents that door registered under a shape's id, recognised by identity and
  never by spelling: anywhere else — a kind schema or named shape writing `schemaCarve`,
  with any value — it contributes nothing, as an unknown keyword does on every other
  validator, so an authored schema means the same on the door as under the plain driver and
  the keyword is no surface. A judgement's key splits on the decision part
  of each carve it reads, never on a text part; a finding whose text reads a text part is
  phrased by the plain driver's own phrasing over the resolved findings and split by
  `splitByReads`. Inside a carve's class every boundary is read by its summary, a
  member-wise one folded into the class's (valid < failing < tag-refused); in a sub-verdict
  no keyword reads, a member-wise boundary stands in empty beside its own sub-verdict. A
  sub-verdict's findings hold under class ∧ reach ∧ pass-through, where pass-through is
  where the keywords between the holder and the carve report what the carve raises — a
  union reporting its branch, an applied `then` / `else` / dependent schema / tuple item, a
  failing `contains`, never beneath `not` or `if` — read off the holder's judgement as a
  label of the reach edge, never part of any memo key. A schema whose references come back
  to the node they left at the same data position — through `$ref`, `allOf`, `anyOf`,
  `oneOf`, `not`, `if` / `then` / `else` and `dependencies` / `dependentSchemas` alone,
  never through `properties`, `patternProperties`, `additionalProperties`, `items`,
  `additionalItems`, `prefixItems` or `contains` — recurses without bound under any
  validator, and is refused where it is declared as `SCHEMA_IN_PLACE_CYCLE` before any value
  is validated against it: in every schema Telo validates a value against (a kind's
  `schema:` / `status:` / `inputType` / `outputType`, a named shape, a callable's `params` /
  `returns`, a need type's `fields` / `parameters`), read within each document and across
  shapes on the in-place edges of the one condition-labelled reach graph, so a cycle
  through a varying shape is one finding labelled with its classes' conditions. Nothing is
  validated against such a schema, as against one `SCHEMA_COMPILE_ERROR` reports; a
  dependency's is reported at the `imports:` entry first reaching it; and the kernel
  refuses the same definition or shape at registration as `ERR_SCHEMA_IN_PLACE_CYCLE`, from
  the one reader both halves share. With that refusal no carve reaches itself at its own
  position, so every sub-verdict is well-founded. A CEL site's member reads, operand types
  and unguarded nullable reads are the engine's verdicts over bindings handed to it as JSON
  Schema with their references intact (1h), so the check's `schemaDependencies` are every
  node beneath a handed binding that its verdicts and its result type read. A finding's text
  is written from the node its verdict names (`schemaNode`), read for its own type, and from
  the classes the site holds up front. A value a chain forwards to a slot or a call's
  parameter is judged over every origin of its result (`resultOrigins`). An origin whose
  type holds an `optional` at any depth is a misfit at every slot, an open one included,
  judged by its CEL type and naming `.orValue(…)` / `.value()`. Any other origin with a
  schema node — present only where the origin's value is an instance of that node, so never
  on an `optional<…>` origin — is judged by a schema comparison of that node against the
  slot's schema, memoised by (position pair, class pair); one without by its CEL type. A
  misfit names the first failing origin in written order, at its range. `cel.bind` and
  `optFlatMap` contribute the origins of the expression they answer; `optional.of`,
  `optional.ofNonZeroValue`, `optMap` and a read through an optional operand (`.?a`, `[?k]`)
  are one origin with their own `optional<…>` type and range. Where an origin's type admits null and its non-null part
  fits, the finding is worded as needing a guard (naming `<chain> != null ? <chain> : …` for
  a plain chain); where it is exactly `null` or its non-null part does not fit, as a type
  mismatch. A CEL
  site answers a boundary reference with one class's document at a time and splits only on
  the shapes whose classes differ at a node its `schemaDependencies` names, or that a
  comparison sub-verdict it joins reads. Every named shape the engine reaches through a type
  it is handed — `self`, `inputs`, `request`, `steps.<name>.result`, `resources.<name>`,
  `variables` / `secrets`, a contract's shapes, a module call's `returns`, which the engine
  reads as a schema — is such a boundary, the one the handed schema names directly included;
  the shapes the analyzer reads itself to place and judge the site — its eval mode and
  regions, the shapes in force along its position and those its annotations name, its slot's
  schema, a call's parameter schemas, a body's fit to `returns` — are held as their reader
  classes up front, as an own-check key holds them. Two classes differ at a listed node when
  the engine says that node's own type differs between them, and a site is split one
  discriminating shape at a time, in the order its nodes were first read; a finding holds
  under the conjunction, over the shapes split, of each chosen cell's class conditions. The
  shared function index resolves each signature once with named shapes left as reference
  edges: no callable is withheld and no key builds a function index of its own. A class's content
  and sub-verdicts are per shape; its condition is per module instance (the import path,
  the entry's own module the root). A library's named shape that
  varies under the library's own inputs is one more shape the reader answers by class: its
  classes are computed once in the library's space and carried into the importer's space
  through the import binding library choices already use — a literal decides the class
  (unlabelled), an expression over decided inputs labels the finding with the importer's
  dimension, an open binding is the import's existing `BRANCH_UNDECIDABLE` in both halves.
  This covers every read of the shape (schema compilation, eval-mode and `x-telo-context`
  annotation reads, `self` typing in a body, each key's door), and two imports of one
  library under different bindings are two instances reading two classes. In the kernel,
  every read of a varying named shape for a declaration (create-time validation, eval
  sites, accessor sites, a template body's entry kinds) goes through the declaring module
  context's view; a shape compiled into the shared validator under its canonical id never
  answers ahead of that view, since one id may hold two contents in one process.
- **Verify:**
  - C(k) at k = 1/4/8/16, each case ended when the first configuration or dead-branch run
    starts: schema-door and relation-door evaluations each t(2k)/t(k) ≤ 2.5 for 4→8 and
    8→16; sub-verdicts ≤ the total number of classes, 2k (counter); every stage over all
    configurations completes at k = 16 — the analysis reaches its first configuration run
    with neither doubling bound exceeded. At k = 1 and k = 4, analysed whole, no door,
    sub-verdict or normalization of the resource is reported after the first configuration
    run starts, except inside a configuration or dead-branch run. On the whole analysis at
    k = 4, a misfit at depth j, for each j ≤ 4, is one finding labelled class_j ∧ reach_j.
  - `function-signature-shape-choice.yaml` does not crash; a body that does not fit
    `returns: !ref Money` is one finding labelled with the misfitting class; the slot-fit
    site's key count is constant over k.
  - Counter: content of a varying shape read anywhere but through the reader = 0, across the
    corpus and the generated corpus.
  - Seeded faults: restoring the fold makes the key count grow with k; a reach condition
    forced TRUE turns the differential red; a judge reading a varying shape's content by id
    makes the withheld-read counter non-zero.
  - Plain-driver text byte-identical, apart from the findings 1h lists.
  - A library kind whose `schema:` references the library's own shape varying under its
    inputs — the `!if` on a property, on the whole schema, and on `x-telo-eval` — checks
    clean and runs; body CEL reading `self.price.amount` through it gives no internal error.
    Bound `whole: !cel "variables.flag1"`, a misfit in one class is one finding labelled
    `(when variables.flag1 is …)`, differential green; classes typing `amount` integer and
    string make `self.price.amount / 2` a `CEL_TYPE_ERROR` under the string class only. The
    reader counter above includes this fixture.
  - One fixture per relating keyword wrapping a `$ref` to a shape varying under
    `variables.flag1`, misfitting in one class → one finding labelled with that class,
    plain-driver text byte-identical, differential green; `shape-carve-any-of-choice` reads
    "matches no alternative — expected a integer, or a boolean". A carved shape holding a
    member-wise `$ref` to a second varying shape misfitting in one class → one finding
    labelled with both conditions. Chain U(k), S_i `oneOf: [{ $ref S_{i+1} }, { type: string
    }]`, each varying: schema-door evaluations t(2k)/t(k) ≤ 2.5 at k = 4→8→16; sub-verdicts
    ≤ 4k at k = 4/8/16 (each shape's two classes times the at most two decisions of the
    carve it reads) and t(16)/t(8) ≤ 2.5; no two sub-verdicts share a memo key and no key
    holds a text part (counter); differential green at k = 4. Chain T(k), S_i `oneOf: [{
    $ref S_{i+1} }, { enum: ["<i>-on"] }]` where `variables.flag<i>` holds and `{ enum:
    ["<i>-off"] }` where it does not, S_k `enum: ["<k>-on"]` / `["<k>-off"]`, the value `0`,
    so every carve has one decision and two texts per class: sub-verdicts ≤ 2k at k =
    4/8/16, no key holds a text part (counter), the root finding's text is the plain
    driver's in every configuration and the differential is green at k = 4. Seeded fault:
    keying a carve's class by its text puts T(8) over the sub-verdict bound. Seeded faults: an empty stand-in under a relating keyword
    turns the union fixtures' differential red; a member-wise boundary inside a carve's class
    standing in empty turns the member-wise-in-carve fixture red; pass-through forced TRUE
    beneath `not` or `if` turns its fixture red; a summary without its text part makes
    `shape-carve-any-of-choice` read "another shape". Pass-through is held by the
    differential: forced FALSE beneath a union reporting its branch, an applied `then` /
    `else` / dependent schema / tuple item and a failing `contains`, it turns that keyword's
    fixture red, as forced TRUE beneath `not` or `if` does. A kind schema and a named shape writing `schemaCarve` beneath each
    relating keyword (a string, an object, the form a stand-in holds) check as under the
    plain driver, differential green; no finding in the corpus names `schemaCarve`
    (counter); recognising the stand-in by value instead of identity turns that fixture red.
  - `S` with `anyOf: [{ $ref: S }, { type: string }]`, a cycle `S1 → S2 → S1` through
    `oneOf`, and a kind schema with `anyOf: [{ $ref: "#" }]` are each one
    `SCHEMA_IN_PLACE_CYCLE` at the declaration, with no finding about values against it and
    no overflow; dropping the refusal makes the first overflow. A tree shape (`children: {
    items: { $ref: S } }`) is not refused. A cycle only in the class `variables.flag1`
    selects is one finding labelled with that class, differential green. A library's cyclic
    shape is reported at the consumer's `imports:` entry. `tests/check-run-agreement.yaml`
    holds the case with the kernel's refusal as `runFails:`.
  - Engine rows in both languages (`templating/cel-conformance/`, replayed by both): a read
    field is in `schemaDependencies`, an unread one is not; reporting every converted node
    turns the unread row red. A namespace function's result declared as a JSON Schema
    document lists the nodes a check reads through it. Two documents differing at a listed
    node only in a keyword outside its own type (`description`) agree there, and two
    differing in its `type` do not, in both engines. A refused member read names the node it
    judged (`schemaNode`), and a check lists its result's origins (`resultOrigins`), every
    origin node among its `schemaDependencies`; keeping only the first origin turns the
    union rows red. `optional.of(self.a.b)`, `optional.ofNonZeroValue(self.a.b)`,
    `self.?a.optMap(v, v.b)` and `self.?a` (also over a union) are each one origin typed
    `optional<…>` with no `schemaNode`; `cel.bind(n, self.a.b, n)` is one origin at `b`'s
    node typed `string`; `self.?a.b` with `b` missing still names `a`'s node in its
    diagnostic; restoring the `optional.of` relay, or keeping the node on an optional-typed
    origin, turns its row red. A resolver's type name is read as a type expression, so a schema
    resolved to `bytes` three levels deep types `size(…)` as `int`. `note == null ? '-' :
    note` is `string`; `hint == null ? null : lower(hint)` checks; `x == 'a'` over
    `string|null` checks and `x < 'a'` is refused; `x != null ? xs.map(x, x) : []` does not
    narrow the inner `x`; `xs.map(e, e.code.n)` over a nullable `code` is `CEL_NULLABLE_ACCESS` (a receiver call such as `e.code.size()` stays the `CEL_TYPE_ERROR` a nullable receiver gives) and `xs.map(e, e.code != null, e.code.size())` checks; keeping
    proofs across a rebinding turns the shadowing row red. `self.u.p` over a union only one
    branch of which declares `p` is refused once; `self.u.?p.orValue(0)`, `has(self.u.p) ?
    self.u.p : 0` and `!has(self.u.p) ? 0 : self.u.p` check; dropping the member proof turns
    the `has()` row red. `c ? x : null` is `T|null`, `c ? n : 1` with `n` an `int|null` is
    `int|null`, `c ? u : 1` with `u` an `int|string` is `int|string`, `c ? 1 : 'a'` is still
    refused.
  - The CEL chain fixture, in the Node analyzer, on 1h: a chain `self.s.next…next.x + 1`
    through k shapes S_1…S_k, `s` naming S_1 from the kind's own schema, each S_i varying
    with two classes that agree on `next` and type a member `y` the chain does not read
    differently, S_k's two classes typing `x` int and string: site evaluations ≤ 3 (the last
    shape's classes + 1) at k = 1/4/8/16, t(2k)/t(k) ≤ 2.5 for 4→8 and 8→16, and one
    `CEL_TYPE_ERROR` labelled with S_k's string class; a second site `self.s.y + 1` is
    evaluated at most 3 times and is one `CEL_TYPE_ERROR` labelled with S_1's string class
    alone. Seeded faults: treating every boundary as its first class turns the differential
    red; holding S_1 as its reader class up front puts the chain site at 4 evaluations from
    k = 2; restoring the reach fold makes the count grow with k; phrasing a finding from a
    node other than its verdict's `schemaNode` makes the withheld-read counter non-zero. In
    `function-signature-shape-choice.yaml`, a site reading a member of a `Telo.Function`
    result whose `returns` names a varying shape is split only where it reads a node whose
    own type differs between that shape's classes.
  - Two imports of one library under different literal bindings read two classes with one
    sub-verdict computation per class (counter).
  - `tests/check-run-agreement.yaml`: the varying-library-shape case checks clean and boots;
    a literal binding selecting the class a consumer's value misfits (a `!cel` at a field
    that class does not mark `x-telo-eval`) is reported at the consumer's field, with the
    kernel's twin as `runFails:`.

### 1d. A slot inside an extracted declaration

- **Before:** a cut point inside a declaration that inline normalization extracted gets no
  census run, so its sites are found only on the side the first run takes.
- **After:** the census reads every extracted declaration as a declaration of the union under
  its parent's condition ∧ the site condition — the same one-root-run-per-side census and
  content-keyed cache, recursively; no separate nested path.
- **Verify:** fixture with a cut point inside an extracted declaration → one finding labelled
  with the inner class ∧ the outer site condition; differential green; a seeded fault
  skipping the census for extracted declarations turns the fixture red.

### 1e. A declaration's own checks at a slot a varying shape declares

- **Before:** own-check keys read the shapes in force at the declaration's root whole
  (correct, but a product), and where a nested value stands (extracted, or a member of its
  holder) is answered from one witness.
- **After:** each nested place carries its kind of place (extracted | member) and the
  condition it holds under — TRUE where it is extracted in every configuration, FALSE where
  it is content in every one, undecided as today — its content answer holding under the
  negation. The slot's condition comes from the one conditioned reach read (class ∧ reach,
  OR over classes), never a witness; a witness answers only slot-ness that does not vary.
  Where the condition is not constant, an own-check site opens at the slot with two options
  split by separability: under the condition, the reference check; under its negation, the
  schema checks over the value as content; the extracted declaration is a declaration of its
  own under parent ∧ condition. Nothing beneath the slot is cut on the parent's side, and
  nothing is multiplied. The analyzer guide gains: "an own-check site opens at a slot a
  varying named shape declares."
- **Verify:** `shape-inline-slot-schema-choice.yaml` and `shape-inline-slot-kind-choice.yaml`
  stay one labelled finding each; a new fixture with two independently varying slots, each
  misfitting in one class → two findings with their own conditions, own-key evaluations 2
  per site, not 4; a seeded fault answering by witness turns it red; differentials green.

### 1f. A nested `$ref` in a function signature is followed

- **Before:** in both drivers, a `$ref: telo://Self/<Type>` nested inside a `Telo.Function`'s
  `returns.schema` or `params[].schema` object is not followed when a call is typed:
  `Self.price(1).m.amount`, with `m` a `$ref` to a string-typed `Money`, passes.
- **After:** the nested reference in `returns.schema` is followed by the engine's resolver,
  through which 1h reads every module call's result; in `params[].schema` it is made
  canonical where the signature's shape id is produced — no second resolver. A union reads the nested
  shapes through the key's lookup, linearly (1c). If the kernel does not follow it either,
  its half gives the existing sentence and gains a `tests/check-run-agreement.yaml` row.
- **Verify:** `Self.price(1).m.amount` with `m` nesting a `$ref` to a string `Money` is
  refused in both drivers with the code the root shape gives; an object `Money` with
  `amount` gives none; a nested `params` mismatch is refused; `Money` varying under `flag1` is
  labelled, differential green; a chain of k nested signature shapes joins 1g's table with
  t(2k)/t(k) ≤ 2.5. New corpus findings listed; a `Fixed` fragment.

### 1g. Every stage over all configurations stays linear

- **Before:** no stage-by-stage profile exists, and C(8) runs out of memory.
- **After:** a table of time and counters per stage over all configurations — key parts,
  the census, the CEL-site solve, kind annotations, kind contracts, and the rest — at
  k = 1/4/8/16 on C(k) and 1f's chain, each stage within t(2k)/t(k) ≤ 2.5. The
  configuration list, the condition over the configurations it lists, and the configuration
  and dead-branch runs are part 3's.
- **Verify:** the table, recorded in the change's report, measures each stage up to the
  start of the first configuration or dead-branch run, at k = 1/4/8/16 on C(k) and on 1f's
  chain. The configuration list, the condition over it, and the configuration and
  dead-branch runs are listed with their times as part 3's and are not held to the bound.
  Every other stage — the setup run, key parts, the census, the CEL-site solve, kind
  annotations, kind contracts and the rest — is within t(2k)/t(k) ≤ 2.5; any stage over the
  bound is fixed in this part.

### 1h. CEL reads are typed by the engine, to full depth

- **Before:** the engine types every binding the analyzer hands it shallowly. A context
  binding, `inputs`, `request`, `self`, a `variables` / `secrets` entry and a module call's
  result are each an int, double, string, bool, list, map or dyn. `steps.<name>.result` is
  typed only from a literal or a recorded scalar fact, and `self` carries scalar types only
  in a body step's `value:`. Every member read below a binding's first level is judged by a
  second walk over a schema the analyzer inlined, which reports `CEL_UNKNOWN_FIELD`,
  `CEL_NULLABLE_ACCESS` and slot fit while the operand stays untyped. So `self.a.x + 1` with
  `x` a string, `inputs.order.total * 2` with `total` a string, and `Self.price(1).m.amount
  + 1` pass `telo check` and fail when they run.
- **After:** every binding is handed to the engine as its JSON Schema with references
  intact, read through the environment's one resolver: each `x-telo-context` binding;
  `inputs` from the resolved input contract; `request`; `steps.<name>.result` from the
  invoked resource's `outputType`, then its kind's, then open (a literal step keeping its
  closed record); the kernel globals, a reference slot read as the reading it yields; `self`
  from the definition's schema at every CEL site of a template body and of a `base:`
  mapping; `variables` / `secrets` / `module`; and a module call's `returns` as a
  schema-declared result. The engine is the one verdict on a member read, an operand's type
  and an unguarded nullable read, and no second report of a member it refused exists. The
  analyzer words each such finding from the node the verdict names and from the site's
  regions (the scope declaring a member, the referrer withholding a binding, the nearest
  member names), and judges a forwarded value's fit to a slot or parameter schema as a
  schema comparison of the node the check's result was read from. `self` is typed as the
  kernel binds it — the declared view, a declared integer an `int`, a declared number a
  `double` — and a bare `self.<path>` forward is navigated, never typed as CEL. A value
  forwarded to a slot or parameter is fitted over its result's origins, as 1c states. Each
  node of a handed schema the type checker cannot read is one `CEL_SCHEMA_UNJUDGED` warning
  where the node is written (at the engine's `throughReference` when present, else the
  pointer), once per node in the declaring module's own check, labelled with its class
  condition, a namespace result's at its callable's `returns.schema`; every schema copy the
  analyzer hands the engine carries provenance recorded by the composer that builds it
  (inline normalization, merge-form `extends`, a forward view, the registration door) — each
  produced node mapped to the written node it came from, or to built-in — and placement
  reads it with the loader's position index, never matching content and walking no manifest;
  a report no provenance record maps is an internal error; the analyzer's resolver answers
  every reference with the document of the shape it names, or — for a reference
  `CONTRACT_TYPE_NOT_FOUND`, `SCHEMA_TYPE_REF_UNRESOLVED`, `SCHEMA_TYPE_REF_UNKNOWN_ALIAS`
  or `REFERENCE_KIND_MISMATCH` reports at its place — with `dyn`, adding no
  `CEL_SCHEMA_UNJUDGED`; any other reference it cannot answer is an internal error; the
  finding is labelled by the reader class of the shape holding the node alone, never by the
  configuration merge — a node is reported only in the check of the module that wrote it,
  where that module is the root instance; a node a template body wrote is reported in
  the defining module's own check, a forward view reporting only a node the consumer wrote;
  a type name Telo's resolver gave that Telo did not register is an internal error, and a
  `recursive` entry is the engine's declared `dyn`, unreported. In a `Telo.Import`'s
  `variables:` / `secrets:`, `resources` and `ports` are withheld bindings (one
  `CEL_UNKNOWN_IDENTIFIER` naming the configuration-only contract). A located origin is
  judged by schema comparison alone, worded `CEL at '<site>' reads '<chain>', declared
  '<source>', but <the field | taker's declared inputType> expects '<target>'.` at the
  compared node and `… does not fit what <…> expects at '<pointer>': <reason>` deeper, never
  showing a bare root pointer. A member read off a stream is `'<chain>' is a Telo.Stream,
  which holds no members: hand it to a step that consumes a stream and read that step's
  result`. The second, qualified registration of a `variables.<key>` / `secrets.<key>`
  entry typed by a language type is deleted. The engine reads `if` / `then` / `else` as the
  node's own type meeting the union of `if` ∧ `then` and `else`, a branch whose meet is
  empty dropped. A record's declared field whose schema admits a finite set of values — a
  `const`, an `enum` or a union of them, `null` among them, each value read as the field's
  type reads it — carries that set (`fieldEnums`), compared as a set by record equality, the
  environment digest and own-type agreement, so two shapes differing only in a constant stay
  two members of a union; a meet intersects the sets and an empty one makes the field
  absent; a record joined as a map carries none. `<chain>.<m> == <literal>` (either order),
  `!=` and `<chain>.<m> in [<literals>]`, the member read by a literal name, are proofs
  beside `!= null`, `has()` and the type test, composed and dropped beneath a rebinding as
  they are: where the test holds `<chain>` is the members whose `m` can equal a listed
  literal (a value of its set equal by the engine's `==`, or with no set a type overlapping
  the literal's), where it fails the members whose `m` can hold a value outside them (no
  set, or a set not within them); a closed member not declaring `m` is dropped on both
  sides, an open record, a map and `dyn` kept on both; whether `m` is required is not read;
  `<chain>.<m>` is narrowed where the test holds to its members that can equal a listed
  literal. A literal is a string, int, uint, double, bool or null literal, a negated number
  included; anything else proves nothing. The narrowed chain is located as `has()` locates
  it. A member only some shapes declare is refused naming `.?m` and, where a field every
  member declares with a set tells the members holding `m` from the rest, the test on it. A
  union joined with a type it does not include widens by kin: each member of the other side
  that a member of the union stands for is absorbed, each other member whose join with some
  member of the union is one type is added as a member of its own after the union's, and a
  member with nothing in common with any is 'not one type'; two unions join by the same rule
  both ways, and two non-union types join as before. An origin with no schema node is judged
  by the engine's type, a union fitting where every member fits, never by the type's printed
  name. A step's guard reaches the CEL sites it guards as an assumption the engine is
  handed: the check takes `assumptions`, each `{ condition, holds, rebound }` — a
  condition's tree, whether it held on the way to the site, and the chains that may denote
  another value there — derives each one's proofs with its one proof reader as if a `?:`
  enclosed the site, and drops a proof rooted at a `rebound` chain. The analyzer reads the
  guards off the step grammar: `if:` holds over `then:` and fails over each `elseif:` (its
  `if:` included) and `else:`; an `elseif:`'s `if:` holds over its `then:`; `while:` over
  `do:`; a `switch:` checked as `string` makes `<switch> == '<case>'` hold over the case and
  `<switch> in [<cases>]` fail over `default:`; a `try` step's `when:` holds over `try:`,
  `catch:` and `finally:`; an invoke step's `when:` over its own `inputs:`. An assumption
  reaches every CEL site of the steps in the lists it guards, at any depth, and no inline
  declaration, `with:` member, dispatched body or later step. `rebound` holds `resources`,
  `steps.<n>` for each step named `<n>` in the guarded lists, each binding a construct
  between them binds afresh (a `catch:`'s `error`, a repeat's binding), and, in every step
  body whatever dispatches it, every root the condition reads but `steps` and `inputs` — the
  two a resumed run restores from its journal (`variables`, `secrets`, `ports`, `module`,
  `self`, `error`, `request` and every kind-declared binding are read afresh), so no zone is
  read and no call graph is reached. Every judge of the site's
  value reads the narrowed result type. The engine reads `patternProperties` by JSON Schema's applicability: a
  member read by a literal name is typed by the meet of its `properties` entry and every
  pattern matching the name, by `additionalProperties` only where neither applies, placed at
  the one node that applies and nowhere where several do. Under `allOf` each part's patterns
  are read as that part's: a member no `properties` entry declares is the meet over the
  parts of the part's patterns matching it, else that part's `additionalProperties`, and a
  closed or open-to-anything part constrains nothing another part's pattern matches, so
  every such `allOf` is read exactly. A pattern whose schema admits no value makes the names
  it matches absent, and so does any meet at a member position that cannot hold — a field
  becomes absent, a pattern entry admits no value, undeclared members close, a plain list's
  element becomes a tuple of no positions and no rest, a map's value a closed record of no
  fields — never `intersection-empty`, which is reported only where no container holds the
  node. A computed-key read is typed the union of every field, pattern and
  `additionalProperties` type, each read at its node. A pattern is matched by the engine's
  RE2, and one RE2 refuses is `shape-not-read`. A scoped `Telo.Import` is followed by the
  loader wherever it is written — beneath a chosen holder, in a chosen scope array, as a
  member chosen at a scope-member position, in every option at any depth — so the module
  graph is the union over every configuration; each `LoadedGraph.scopedImportEdges` entry
  records the member's written place, option keys included, and its presence is its holder's
  declaration condition and every option on the way. A failure to resolve, load or identify
  its target (`INVALID_IMPORT_SOURCE`, `IMPORT_UNRESOLVED`, `INVALID_IMPORT_TARGET`,
  `KIND_PREFIX_RESERVED`) is unlabelled and refuses the load in every configuration; every
  other finding about it — its `variables:` / `secrets:` judged against its library's
  host-path inputs as an `imports:` entry's are, the need table's entries for its instance,
  the import-anchored refusals of what it reaches — is held under its presence, and its
  library's own defects are that library's own check's, unlabelled. A `Telo.Import` branch
  at a scope-member position is a declaration like any member, named by the tag's
  `metadata`; at a document position it stays `BRANCH_CASE_INVALID`. The loader stamps each
  scoped import's identity on the member at its written place; a `Telo.Import` branch at a
  scope-member position is stamped on its own `metadata`, never the tag's, since each branch
  may reach a different library. Every expansion (one configuration's, the union, the option
  views) carries a chosen member's stamps onto the declaration it emits. The kernel stamps
  its own compiled reading of the written files by each edge's place before it expands, so
  the import controller loads no target a load followed. On every `Telo.Import` — an
  `imports:` entry, a top-level document, a scope member — an expansion construct at `kind`, `metadata`, `source` or `integrity`, or a `...` splice at
  the import's own top level (which may write any of them), is refused by the loader (`BRANCH_POSITION_INVALID`
  for `!if` / `!switch`, `REPEAT_OUTSIDE_TEMPLATE` for `!for-each` and a `...` splice),
  worded `'!<tag>' at '<path>' of the Telo.Import: the loader reads an import's alias and
  source before anything is expanded, so they cannot be chosen or repeated. Write them
  plainly.`; every other field is a value position read per option, and every reader of an
  import's inputs (every reader: host-path inputs, literal validation against the library's entries, the
  library's dimensions read through the import's binding, the need table's supplies — a
  library's own imports' included, read in each consumer through that binding while the
  library-local defects stay the library's own verdict —, shared-library agreement, the
  resource-input checks and the references to an optional input one option omits, the
  callable-data check of a `resources:` supply, the text checks, and the call graph with its
  cycle search) holds each finding under the options on the way to the value. A library
  `variables:` / `secrets:` entry typed `Text` or `Message` is a text parameter: the value an
  import supplies is a text the importing module writes, judged in its `lang:` (`MESSAGE_*`)
  and enumerated among its texts (`MESSAGE_TEXT_UNUSED`, `MESSAGE_TRANSLATION_MISSING`), a
  computed one `TEXT_ARGUMENT_COMPUTED` at check and `ERR_TEXT_ARGUMENT_COMPUTED` when the
  import initializes; the kernel hands the library the record `{ text, context, lang,
  computed }` attributed to the importer, and inside the library `variables.<name>` /
  `secrets.<name>` is typed `TextRecord`; the entry's `default:` is the library's text,
  judged and attributed as the library's. A text parameter is read at the import as a slot
  taking a text or a text record: an expression is admitted only where its result can only
  be a `TextRecord`, which the kernel passes on unchanged, its writer's attribution kept and
  never judged again, and any other expression is `TEXT_ARGUMENT_COMPUTED` /
  `ERR_TEXT_ARGUMENT_COMPUTED`; an entry typed `Text`, `Message` or a union of either with
  `TextRecord` is one text parameter. Shared-library agreement compares a text parameter by
  its settled record — the message core's identity of text and context, `lang` and
  `computed` — in `telo check` as at boot, so one text from two importers of different
  `lang:` is `SHARED_LIBRARY_CONFLICT`. Every `variables:` / `secrets:` entry of a
  `Telo.Library` and of a `Telo.Application` is declared in the built-in vocabulary as a
  JSON Schema position (an Application entry keeping its `env` / `arg` / `type` / `default`
  constraints beside it), so each is a schema root a recursive fragment is hoisted into, and
  every reader composing entries into one schema lifts those definitions to its root. An
  Application entry typed `Text` is data of that shape, never a text parameter: a
  host-supplied value has no writing module. The kernel's
  need table is built over the running configuration's expansion — the one its resources are
  created from — so a supply behind a choice is a supply only where the taken option writes
  it, and where the option omits it the need is forwarded or read from the environment as an
  unsupplied one is; its need-presence dimensions are read after the inputs that decide
  whether the need is left to the environment. Any analysis error refuses every run, whatever
  its configuration label. A `Telo.Import`'s
  `variables:`, `secrets:` and field-by-field `needs:` supplies are values the import hands
  its library, and `!module-path`, `!include-text` and `!include-bytes` are values there as
  at a resource field, anchored at the importing module: the file is claimed by `telo
  publish` / `telo package` and asked of the source at load for the entry and every
  path-imported module (`MODULE_PATH_NOT_FOUND`, `INCLUDE_FILE_NOT_FOUND`, the found entry
  and head held to the library input's `entry` / `mediaType` as `HOST_PATH_ENTRY_MISMATCH`
  / `HOST_PATH_CONTENT_MISMATCH`, reported at the import); a `!module-path` is typed
  `Telo.HostPath` and held to the library's entry as at a resource field, and
  `HOST_PATH_UNTYPED_SOURCE` asks a tag's produced value type, never its JSON base type, so
  it never reports `!module-path`. The kernel resolves each tag when the import initializes
  — an `imports:` entry at load, a scoped import once per scope run — through the importing
  module's own module-file resolution, before the inputs are validated against the
  library's entries; a field-by-field `needs:` supply is resolved where that supply's CEL is
  evaluated. `MODULE_PATH_OUTSIDE_RESOURCE` / `INCLUDE_OUTSIDE_RESOURCE` remain for every
  other field of a `Telo.Import` and for the module documents outside a need's
  `parameters:`; a module document's `imports:` map is judged only at its desugared
  `Telo.Import`, so no such finding is reported twice. An Application `variables:` / `secrets:` entry's `$ref` carries
  the canonical id every other written reference to a named shape gets, so `variables.<key>`
  is typed from the shape it names and a missing one is `SCHEMA_TYPE_REF_UNRESOLVED` alone. A schema that admits no value is absence where absence is representable — a
  property in `absentFields`, `additionalProperties` closed, a tuple's rest closed, a union
  branch dropped — and `intersection-empty` elsewhere. The environment digest and the
  own-type agreement carry `prefixElements`, `additionalElements`, `additionalFields` and
  `absentFields`, and the subschema nodes of `not` and `if` / `then` / `else` are listed
  when read. Until the CEL keys' late split, a reference is answered through the key's shape
  lookup as today.
- **Verify:**
  - `self.a.x + 1` with `x` a string, in a body step, a body's `inputs:` and a `resources:`
    entry's field: one `CEL_TYPE_ERROR` each; with `x` an integer it checks and runs.
    `inputs.order.total * 2` with `total` a string: one `CEL_TYPE_ERROR`. `self.n * 10` with
    `type: number` in a body step's `value:` is a `CEL_TYPE_ERROR`; with `type: integer` it
    checks and runs (`Assert.Equals` on the result).
  - `self.a.y` with `y` undeclared in a closed `a`: one `CEL_UNKNOWN_FIELD`, and across the
    corpus no range carries two findings for one member read (counter). An unguarded read
    through a nullable member is one `CEL_NULLABLE_ACCESS`; `a != null && a.b` is none.
  - `Self.price(1).m.amount + 1` with `m` a `$ref` to a shape typing `amount` a string: one
    `CEL_TYPE_ERROR`.
  - A chain from a string with no `format` into a slot declaring `format: date` is still a
    `CEL_TYPE_ERROR`.
  - Counter: no analyzer or templating path reads a schema node beneath a binding handed to
    the engine except through the engine's resolver or a comparison sub-verdict (0 across
    the corpus). Seeded fault: registering one binding through the shallow conversion makes
    the first row pass.
  - The corpus dump lists every new or reworded finding; every manifest in the tree newly
    refused is fixed in the same change; differential green.
    `tests/check-run-agreement.yaml`: a body reading `self.a.x` at depth checks and boots
    with the value check typed, and a `base:` mapping doing arithmetic on a declared integer
    field checks and boots.
  - `optional.of(self.a.b)` and `self.?a` at a `string` slot, and `[self.?a]` at an untyped
    array slot, are each refused naming `.orValue(…)`; `self.?a.orValue('x')` at a `string`
    slot checks clean; `cel.bind(n, self.a.b, n)` is fitted by node; twins in
    `tests/check-run-agreement.yaml`.
  - The CEL conformance rows whose `context` answers move are re-recorded, and both runners
    replay them green.
  - Over `u` = `anyOf` of `{k: const a, p: integer}` (both required, closed) and `{k: const
    b}` (closed): `u.k == 'a' ? u.p : 0`, `'a' == u.k ? u.p : 0`, `u.k != 'a' ? 0 : u.p`,
    `!(u.k == 'a') ? 0 : u.p`, `u.k == 'b' ? 0 : u.p` and `u.k in ['a'] ? u.p : 0` check
    typed `int` with `u.p` at `/anyOf/0/properties/p`; `u.k == 'a' && u.p > 0` and `u.k !=
    'a' || u.p > 0` check; `u.k in ['a', 'b'] ? u.p : 0`, `u.k == 'c' ? u.p : 0` and
    unguarded `u.p` are each one `CEL_UNKNOWN_FIELD` naming `.?p` and the test `u.k == 'a'`;
    `u.k == 'a' ? [v].map(u, u.p) : []` is refused; with `k` typed `string` in both branches
    it is still refused; `k: {enum: [a, null]}` keeps that branch under `u.k == null`; `n:
    {const: 1, type: integer}` narrows under `u.n == 1`; `x == 'a' ? x.size() : 0` over
    `string|int` checks; `anyOf` of `{k: const a, x: string}` and `{k: const b, x: string}`
    is two members; `allOf` of `k: enum [a, b]` and `k: enum [b, c]` is `{b}`, and disjoint
    enums make `x.k` declared-absent with `has(x.k)` checking; records differing only in a
    field's set are unequal with different digests (Node unit test); dropping the
    where-false rule turns the `!=` rows red and ignoring `fieldEnums` in equality the
    two-member row; the 2 discriminant corpus findings are gone with no manifest edit.
    `[{'a': 'x'}] + ms`, `ms + [{'a': 'x'}]` and `c ? {'a': 'x'} : ms[0]` over a list of a
    union of two closed records check as the union of the literal's map and both records; `c
    ? true : ms[0]`, `c ? (int|string) : (int|bool)` and `[1] + ['a']` are still refused;
    that result into a list-of-integer slot is one `CEL_TYPE_ERROR`; restoring 'union and
    non-included type is not one type' turns the `+` row red; the 8 list-`+` corpus findings
    are gone. Engine rows with `assumptions`: `a.b` with `a` nullable under `{condition: a
    != null, holds: true}` checks, with `holds: false` is `CEL_NULLABLE_ACCESS`, with
    `rebound: [a]` is refused. Analyzer: the `examples/ui-showcase` shape (`if: inputs.item
    != null`, a `throw` reading `inputs.item` in `then:`) has no finding and keeps it in
    `else:`; `if: x == null` → `elseif: true` reading `x.a` checks; `switch: inputs.u.k`
    with case `a` reading `inputs.u.p` checks and under `default:` is refused; `while:
    steps.n.result != null` whose `do:` re-writes `n` then reads `steps.n.result.a` is
    refused; `if: resources.x.status.y != null` then a read beneath `.y` is still refused;
    an invoke step `when: x != null` with `inputs: { a: !cel "x.b" }` checks; an inline
    `Telo.Value` under `then:` is not narrowed; a library exporting a `Telo.Sequence` whose
    `if: variables.x != null` guards `variables.x.y` in `then:` is `CEL_NULLABLE_ACCESS` in
    its own check with no durable region anywhere, and so is `error.data` guarded inside a
    `catch:`; `inputs.item != null` and `steps.a.result != null` still narrow in a plain
    sequence, in a body providing `replayed` and in a sequence dispatched from one, with the
    plain and keyed analyses agreeing; carrying an assumption to the step after
    the `if`, or not rebinding `steps.<n>`, turns a row red; `examples/ui-showcase` checks
    clean with no manifest change.
  - `variables.cfg.blob + 1` with `blob` a `Telo.Bytes` two levels deep is one
    `CEL_TYPE_ERROR` naming `bytes`. A `type: null` producer into a `string` slot reads as a
    type mismatch naming `null`; a `T|null` into `T` reads with the guard; a computed `c ? x
    : null` into `T` names the `null` branch. The slot findings of the call-site CEL types
    tests hold with no host walk; counter: no slot fit reads a schema beneath a handed
    binding except through an origin's node. A kind whose `schema:` uses
    `unevaluatedProperties`
    yields one `CEL_SCHEMA_UNJUDGED` at that line whatever the number of CEL sites; a
    missing `$ref` yields only `SCHEMA_TYPE_REF_UNRESOLVED`; every schema of the built-in
    vocabulary — each kind's `schema:` / `status:` / `inputType` / `outputType`, each need
    type's `fields` / `parameters` and every `telo://manifest#/$defs` fragment, `Step`
    included — converted through the analyzer's resolver yields none (an enumeration of the
    archive, not of the bindings a site types); a keyword it finds is read by the engine or
    the built-in schema is rewritten, never exempted. The corpus dump lists every new `CEL_NULLABLE_ACCESS` at a
    comprehension variable and every `CEL_SCHEMA_UNJUDGED`.
  - One engine row per rule of the engine's schema and union reading, in both engines:
    `self.m.extra + 1` is one `CEL_TYPE_ERROR` with `m` having `properties: {a}` and
    `additionalProperties: {type: string}`, checks with `{type: integer}`, its `schemaNode`
    `…/additionalProperties`, `self.m.a` still typed as `a`, a closed `m` still
    `CEL_UNKNOWN_FIELD`; `'k' in self.m` over an open record checks, an open record with a
    declared `int` field is still refused as a `map<string, string>` argument; `self.pair[0]
    + 1` is one `CEL_TYPE_ERROR` over `items: [{type: string}, {type: integer}]`,
    `self.pair[1] + 1` checks, `self.pair[2]` with `additionalItems: false` is one
    `CEL_TYPE_ERROR`; `self.pair[2] + 1` is one `CEL_TYPE_ERROR` with `additionalItems:
    {type: string}` (`schemaNode` `…/additionalItems`) and with `prefixItems` + `items:
    {type: string}` (`…/items`), and checks with no rest keyword; `items: false` makes
    `self.xs[0]` one `CEL_TYPE_ERROR`; a closed and an open `items: [{}, {type: string}]`
    are unequal types; `prefixItems` beside `additionalItems` is one `shape-not-read`; `type: [string, "null"], not: {type: "null"}` reads as `string`, `not:
    {properties: {a: {type: string}}}` is one `shape-not-read` report, `x.user` with `user:
    {not: {}}` is `CEL_UNKNOWN_FIELD` and `has(x.user)` checks; under `allOf: [{properties:
    {user: {type: string}}}, {properties: {user: false}}]` the same holds with no
    `intersection-empty`; with `additionalProperties: true` and `user: false`, `x.other` is
    `dyn` and `x.user` refused; `additionalProperties: {not: {}}` and `false` give equal
    types; a union of `{user: string}` with an open record declaring `user` absent refuses
    `x.user` naming `.?user`; `if: {properties: {kind: {const: a}}}, then: {properties: {v:
    {type: string}}}, else: {properties: {v: {type: integer}}}` types `x.v` as `string|int`,
    `if: {type: string}, then: {minLength: 1}, else: {type: integer}` reads as `string|int`,
    and `Step`'s root reads with no report; `self.m.ab + 1` with `m` having
    `patternProperties: {'^a': {type: string}}` is one `CEL_TYPE_ERROR` (`schemaNode`
    `…/patternProperties/^a`) and checks with `{type: integer}`; `self.m.x` is
    `CEL_UNKNOWN_FIELD` with no `additionalProperties` and typed by it when present; a
    declared `a1` matching `^a` is the meet of both, placed nowhere, listing both nodes;
    `'^(?=a)'` is one `shape-not-read`; under a `{not: {}}` pattern `has(self.m.ab)` checks
    and `self.m.ab` is refused as declared absent; two records differing only in a pattern's
    text are unequal types with different environment digests;
    `analyzer/library-migration-conformance/checks/refused-by-schema` is unchanged; under
    `allOf` of part A (`^x-` typed `string|integer`, `additionalProperties: {type:
    integer}`) and part B (`y-` typed `integer|boolean`, no `additionalProperties`),
    `x['x-1']` is `string|int` placed at A's pattern, `x['y-1']` is `int` placed nowhere
    listing B's pattern and A's `additionalProperties`, `x['x-y-1']` is `int` placed nowhere
    listing both patterns, and no `CEL_SCHEMA_UNJUDGED`; flattening the parts fails the
    `y-1` or `x-y-1` row; with parts A (`^a`, `^b`; `additionalProperties` int), B (`^a`;
    bool) and R (`^a`; closed), `x.b1` reads A's `^b` entry met with bool, placed nowhere,
    listing both nodes, and dropping the merged B∪R part's `additionalFields` fails it; with
    A (`^b` typed int), B (`^a`; bool) and B′ (`^a`; string), `x.b1` is absent, and merging
    B with B′ fails it; `allOf: [{patternProperties: {'^a': {type: string}}}, {properties:
    {b: {}}}]` reads `x.ab` as `string`; two closed parts with patterns `^a` and `b` read
    `x.ab1` as the meet of both and `x.a1` as A's alone; `allOf: [S, S]` equals S in type
    and digest for S with patterns and a typed `additionalProperties` and for S closed with
    patterns; `allOf: [{properties: {a: {type: string}}}, {properties: {a: {type:
    integer}}}]` makes `x.a` `CEL_UNKNOWN_FIELD` (declared absent, listing both nodes),
    `has(x.a)` checks, no `intersection-empty`; `allOf` of `items: {type: string}` with
    `items: {type: integer}` makes `xs[0]` one `CEL_TYPE_ERROR`; `x[k] + 1` over `{a:
    string, b: integer}` is one `CEL_TYPE_ERROR` naming the `string` combination, checks
    over `{a: integer, b: integer}`, its origins listing both property nodes; counters: no
    `shape-not-read` with keyword `patternProperties` except a pattern RE2 refuses, no
    `intersection-empty` below a registration root, across the corpus and the vectors; a closed `{a}` and a closed `{a}` with `b:
    false` are unequal types — `c ? x : y` over the two joins as a map, not the record, in
    both engines — and two environments registering them have different environment digests
    (a Node unit test; the Rust crate carries no digest), `has(x.b)` checks as `bool`
    over the second, `has(x.c)` is still one `CEL_UNKNOWN_FIELD` over both, `allOf` of a
    closed `{a}` with `{properties: {b: {type: string}}}` types `x.b` as `string` and the
    same over a closed `{a}` with `b: false` refuses `x.b` with the declared-absent message
    at the `b` property's node; `allOf` of an open `{a}` with `{properties: {b: {type:
    string}}}` places `x.b` at the second part's `b` node (`schemaNode`, `resultOrigins`,
    `schemaDependencies`); with both parts declaring `b`, `x.b` is placed nowhere and its
    read lists both `b` nodes; `allOf: [{$ref: '#/$defs/P'}, {$ref: '#/$defs/Q'}]`, with P
    and Q two nodes of identical content `oneOf: [{properties: {a: {type: string}, b: {type:
    integer}}}, {properties: {a: {type: string}, c: {type: boolean}}}]`, types `x` equal to
    a binding typed by P alone (two members, no third), `x`'s origins are one at the node
    holding the `allOf`, and `x.a` is `string`, one origin with no `schemaNode`, its read
    listing all four `a` nodes; `allOf: [{$ref: '#/$defs/P'}, {$ref: '#/$defs/P'}]` places
    `x.a` nowhere, listing P's two `a` nodes; that union as the type of a field `u` of two
    equal records met places `x.u.a` nowhere; `allOf: [{type: array}, {items: {type: string,
    maxLength: 3}}]` places `x[0]` at `/allOf/1/items` and nowhere when both parts declare
    `items`, and a tuple position declared by one part alone is placed at its `prefixItems`
    node; for every schema S the schema rows convert, `allOf: [S, S]` converts to a type
    equal to S's; restoring the equal-union shortcut turns the P/Q rows red, and
    distributing equal unions turns the type row red. A read through `allOf: [{properties:
    {a: {type: string}, b: {type: integer}}}, {properties: {c: {type: boolean}}}]`: `x.a`
    lists `/allOf/0/properties/a` and neither `b` node nor `c`, and two documents differing
    only in the `type` of `/allOf/0/properties/b` agree on every node it lists; `allOf:
    [{properties: {a: {type: string}}}, {additionalProperties: {}}]` lists
    `/allOf/1/additionalProperties` for `x.a`, and with that node `{type: integer}` the
    intersection is empty; `allOf: [{properties: {a: {type: string}, b: {type: string}}},
    {properties: {b: {type: integer}}}]` makes `x.a` `dyn` with `intersection-empty`, its
    read listing both `b` nodes; `x` used whole lists every node of both parts; restoring
    the whole read of an intersection turns the unread rows red, and listing only declarers
    (no `dyn` holder) turns the `additionalProperties: {}` row red; dropping `absentFields` on closed records makes the closed
    `allOf` row type `x.user` as `string`; `type(u) == string ?
    u.size() : 0` checks over `string|map`, `u.size()` unguarded over `string|bool` is one
    `CEL_TYPE_ERROR` naming `bool`, `string(int|null)` is still refused, a 3-argument call
    over three 4-member unions (64 combinations) resolves per combination, a 2-argument call
    over a 5-member and a 13-member union (65) is the limit refusal, and a 7-argument call
    of 2-member unions, wider than any overload of its name declares, is the refusal as
    written and never the limit refusal; `x == null` over a map checks and `1 == 'a'` is
    still refused; `xs + ys` over `list<map<string, string>>` and `list<map>` checks and
    `[1] + ['a']` is still refused. The meet is linear in depth, in both engines: on the
    identity diamond, the two-chain diamond (`d_i = allOf[{a: d_{i-1}}, {a: e_{i-1}}]`, `e_i =
    allOf[{a: e_{i-1}}, {a: d_{i-1}}]`) and the union diamond (each half `oneOf` of `{a:
    d_{i-1}}` and `{a: d_{i-1}, b: string}`), `heldHolders`, `builtContainers` and the reading
    entries built each satisfy c(32) ≤ 2.5·c(16) and c(16) ≤ 2.5·c(8), and listing `x.a…a.v`
    on the first two steps through entries under the same bounds; the identity and two-chain
    diamonds at depth 4, a union-typed `allOf` read at two nodes and as a field after a node,
    and the P/Q, P/P, `allOf: [S, S]` and union-as-field rows answer byte for byte what the
    quadratic build answered (`schemaDependencies`, `schemaNode`, `resultOrigins`). Negative
    controls, recorded with the gates, red in both engines: dropping the unique table turns
    every diamond gate red; dropping union interning alone turns the union-diamond gate red;
    placing the interned union at the first node read (instead of always copying) turns
    `union_meet_field_after_node` red; copying no union turns `union_meet_second_node_unknown`
    and `union_meet_field_after_node_unknown` red; replaying nothing on a computed-table hit
    turns the `meetSharing` rows red. A walk over a type visits each distinct type object
    once, in both engines, counted rather than timed: on the binary shared schema `d_i =
    {properties: {a: {$ref: d_{i-1}}, b: {$ref: d_{i-1}}}}` the type visits a check of `x` and
    of `x.a.b.a` performs, conversion included, satisfy v(24) ≤ 2.5·v(12) and v(48) ≤
    2.5·v(24), and a check of `x` at depth 64 completes; dropping the memo from
    `withoutParameters` alone turns it red, and so does dropping it from `holdsOptional` alone,
    in both engines; the union diamond's check of `x` at depth 20, 40 and 80 takes
    milliseconds; a record whose patterns `^a` and `^ab` both `$ref` one shape `S`
    (`telo/meetSharing/one_shape_met_with_itself_at_a_read`) reads `x.abc.q` as one
    `resultOrigins` entry with no `schemaNode`, `/$defs/S/properties/q` in
    `schemaDependencies`, and the identity shortcut in the meet turns it red in both engines.
    A printed type is cut: in both engines a type of exactly 64 nodes prints whole, one of 65
    is cut at the 65th, and the `oneOf` array/object diamond at depth 16 prints its pinned cut
    text (`telo/typeText/<case>`); on that diamond the text a check of `x` prints writes
    `TYPE_TEXT_NODE_LIMIT` type names and one `...` at depths 16, 32 and 64, its length within
    the limit's bound, and a check of `x` at depth 64 completes; removing the cut turns the
    depth-16 row and the gate red; no existing row prints a type of more than 64 nodes. The
    printed type of `x` on that diamond writes exactly 64 type nodes followed by one `...` at
    depths 16, 32 and 64, within one constant the test declares; a namespaced function whose
    result is that diamond declared as a schema lists in the same bounded text, its digest work
    linear in depth, and two such results differing past the cut digest apart; removing the cut,
    or writing that line whole, turns them red. `wrap(x) == wrap(y)` with `wrap(A): Box<A>` over
    two records of different fields is `CEL_TYPE_ARGUMENT_MISMATCH`
    (`telo/typeArguments/records_of_two_shapes`), red in both engines when arguments are compared
    by text. The rows' `calls` record `argumentTypeNames` and a module call argument's `typeName`;
    a module call whose argument is a union of more than 64 nodes, a member past the cut failing
    the parameter, is `FUNCTION_ARGUMENT_MISMATCH`, and pointing the check back at the text — the
    root before `<` or the whole text parsed — loses it; a search finds no printed type parsed in
    the analyzer, ide-support, the language server, templating or the Rust twins, and none
    compared or looked up either — the string-subject test, the message value kind, a step
    fact's recorded scalar, the brand hint, the slot rules' roots, a choice's selector type and
    an editor's type names all read the CEL type; a record and a bare map, both printed `map`,
    are told apart by the message value kind; an `!interpolate` hole converts exactly when
    `string(<hole type>)` resolves through the registry. A namespace listing's entry for a
    schema-declared result carries `resultType` and a signature's carries none, in both engines,
    and two environments whose schema-declared results differ only beyond the cut digest apart.
    The language rows and the analyzer batch stay byte-identical. 
    mail-resend, `tests/instance-union-decoding.yaml`, the crud `in` sites and the
    authoring-agent `+` sites check clean; the lost host tuple finding is back in the corpus
    dump.
  - Counters: zero `CEL_SCHEMA_UNJUDGED` dropped for lack of a place across the corpus and
    the generated corpus; placement does zero manifest walks and zero content hashes, one
    provenance lookup per reported node; a fixture where only the `variables.flag1` class of
    a varying shape uses `unevaluatedProperties` gives one `CEL_SCHEMA_UNJUDGED` labelled `(when
    variables.flag1 is true)`, emitted outside any configuration run; a forced missing
    provenance entry raises the internal error; no consumer of a templated kind reports a
    node its body wrote. `tests/__fixtures__/configurations/host-path-import-choice.yaml`
    supplies `root: !cel "variables.plainDir"`, an importer variable declared `type:
    string`, twice: its `imports:` entry reports `HOST_PATH_UNTYPED_SOURCE` unlabelled, and
    a `Telo.Import` in the `with:` of a `Telo.Sequence` written as the `then` of an `!if` on
    `variables.flag1` reports it at that member's `variables.root` labelled `(when
    variables.flag1 is true)`; the relative `extra` is `HOST_PATH_RELATIVE` at each; an
    Application variable `$ref`-typed to a named shape whose `dir` member is a string makes
    `variables.cfg.dir + 1` one `CEL_TYPE_ERROR`, and a `$ref` naming nothing is only
    `SCHEMA_TYPE_REF_UNRESOLVED`; `returns: { schema: !ref thing }` with `thing` an
    Invocable is one `REFERENCE_KIND_MISMATCH` at the `!ref`, no `CEL_SCHEMA_UNJUDGED`, and
    `ERR_REFERENCE_KIND_MISMATCH` at load (twin in `tests/check-run-agreement.yaml`); a
    forced reference answered neither way raises the internal error; a scoped import with
    `source: ./nowhere-lib` beneath a chosen holder, in a `with: !if`, and as a member
    chosen at a scope-member position is `IMPORT_UNRESOLVED` at the member, unlabelled, and
    `ERR_IMPORT_UNRESOLVED` at load with `flag1` false and true (twins in
    `tests/check-run-agreement.yaml`); a library reached only that way declaring a required
    need nothing supplies is listed by `telo needs report` as `required when FLAG_1 is true`
    and is `ERR_NEED_UNMET` at load only with `flag1` true (twins in
    `tests/check-run-agreement.yaml`), with no static finding beside it, as for an
    unconditioned import; such an import supplying a need its library does not declare is
    `NEED_UNDECLARED`, and one reaching a library whose need names an unresolvable type is
    `NEED_TYPE_UNRESOLVED` at the import, each labelled `(when variables.flag1 is true)`;
    dropping the loader's option walk turns these rows red; counter: the import controller's
    own target load is taken zero times across the manifest suite for a member of a loaded
    manifest, with `flag1` false and true; dropping the expansion's carrying of a chosen branch's stamps turns the
    scoped-import-choices test red (its boot fails); making the import controller load its own
    target for a member the load stamped makes the counter non-zero; two branches of one scope-member `!if` reaching
    different libraries each boot under their setting with their own library's exports
    (`Assert.Equals`); `variables: {
    root: !if { if: !cel "variables.flag1", then: !module-path ./a, else: !cel
    "variables.plainDir" } }` at an `imports:` entry and at a scoped import is
    `HOST_PATH_UNTYPED_SOURCE` labelled `(when variables.flag1 is false)`, its `then` branch reporting nothing; since any analysis error refuses every run whatever
    its label, the fixture is refused at load with `flag1` false and true (`runFails:`
    carrying the labelled finding); its typed twin — `else` a variable declared `x-telo-type:
    Telo.HostPath`, `then` still `!module-path ./a` — checks clean and boots under each
    setting handing the library the taken branch's value: the absolute path of the importer's
    `./a` with `flag1` true, the variable's resolved path with `flag1` false (`Assert.Equals`); `variables: { root: !module-path ./a }` at an `imports:` entry,
    a top-level `Telo.Import` and a scoped import checks clean with no
    `MODULE_PATH_OUTSIDE_RESOURCE` and boots handing the library the absolute path of the
    importer's `./a`, not the library's directory (`Assert.Equals`), from a library
    importing a library too, from a checkout and from a published artifact; `./missing` is
    `MODULE_PATH_NOT_FOUND` at check and refuses `telo run` at load (twin in
    `tests/check-run-agreement.yaml`); a directory at an input declared `entry: file` is
    `HOST_PATH_ENTRY_MISMATCH` at the import; `!include-text ./note.txt` at a string input
    boots with the file's text; `telo publish` of the importer carries `./a`; a
    `!interpolate` at a host-path input is still `HOST_PATH_UNTYPED_SOURCE`; the Rust analyzer
    agrees through a check-conformance vector, and the `module-path-outside-resource` vector
    keeps its Application / Library document rows; `source: !if`
    in each of the three forms is `BRANCH_POSITION_INVALID` with the import wording, refused
    at load before analysis; a library imported only beneath `!if variables.flag1` whose
    kind uses `unevaluatedProperties` gives its `CEL_SCHEMA_UNJUDGED` unlabelled, in its own
    verdict; a read of
    `resources` in an import's `variables:` is one `CEL_UNKNOWN_IDENTIFIER` and no slot
    finding beside it. The predicate rows in `tests/check-run-agreement.yaml` read `reads
    'variables.flag', declared 'string', but the field expects 'boolean'.` A library (`lang:
    en`) declaring `variables: { title: { $ref: "telo://manifest#/$defs/Text" } }`, imported
    by an application with `lang: pl`, at an `imports:` entry, a top-level `Telo.Import` and
    a scoped import: a plural `title` with a `few` case checks clean, and the same import from
    a `lang: en` importer is `MESSAGE_PLURAL_CATEGORY_INVALID` at the import's
    `variables.title` (judged in the importer's language, not the library's); `title: !if {
    if: !cel "variables.flag1", then: "{$x", else: "Hello" }` is `MESSAGE_SYNTAX_INVALID`
    labelled `(when variables.flag1 is true)` and nothing for `else`; `title: !cel
    "variables.name"` is `TEXT_ARGUMENT_COMPUTED` at check and refuses the run with
    `ERR_TEXT_ARGUMENT_COMPUTED` (twin row in `tests/check-run-agreement.yaml`); a
    `Telo.Value` in the library returning `variables.title` boots and yields `{ text:
    "Hello", context: null, lang: pl, computed: false }` (`Assert.Equals`), per scope run for
    the scoped import; the importer serving a `de` catalog that lacks `Hello` is warned
    `MESSAGE_TRANSLATION_MISSING` listing it; the entry's `default:` is judged in `en` and
    yields `lang: en`. Removing the import input from the text enumeration turns the coverage
    row red; attributing the record to the library turns the `Assert.Equals` row red. A
    library with `variables: { title: { $ref: "telo://manifest#/$defs/Text" } }` checks clean
    and an importer of it runs; an Application variable whose `$ref` is a recursive fragment
    checks and boots; an Application variable missing `type:`, and one with neither `env:`
    nor `arg:`, are still `SCHEMA_VIOLATION` at check and at load; a library entry `{ type:
    strng }` is one `SCHEMA_VIOLATION` at the entry; removing the lift from any one reader
    composing entries makes the importer's run fail on an unresolved `#/$defs/telo:Message`;
    no `#/$defs/telo:*` reference in the corpus is left dangling. A library importing a
    second library with `title: !cel "variables.title"` checks and runs, the inner library's
    record carrying the outer importer's `lang` and text (`Assert.Equals`), and adds no
    `MESSAGE_*` finding in the forwarding library; `title: !cel "'x'"` and a `dyn` expression
    are `TEXT_ARGUMENT_COMPUTED` at check and `ERR_TEXT_ARGUMENT_COMPUTED` at run. A shared
    library imported from an `en` module and from a `de` module, each writing `title:
    Hello`, is `SHARED_LIBRARY_CONFLICT` at check and `ERR_SHARED_LIBRARY_CONFLICT` at boot,
    the message naming both languages; two `en` importers writing `Hello` and `{ plural: count,
    cases: { other: Hello } }` check and boot; two importers both omitting the entry agree on the library's default.
    Each refusal is twinned in `tests/check-run-agreement.yaml`. The
    corpus dump's wall time, over the manifests both trees hold, is at most 1.05× the base
    tree's: the base tree is the main commit this tree forks from with every merged part of
    this plan reverted, newest first — a conflicting revert resolved toward the pre-part
    text with the other commit's change kept, and a file a part added that a later commit
    outside this plan builds on kept as that commit needs it — rebuilt from each part's own
    fork point when that part measures; the base tree builds and runs the dump commands, and
    its diff against this tree outside this plan's parts is empty, so the ratio carries this
    plan's cost alone. The base tree and this tree are
    dumped on the same host, each reading its own sources, in at least three interleaved
    pairs (base, tree, base, tree, …) with the same commands and concurrency, and the bar is
    the ratio of the medians, for the whole dump and for each corpus part (main and `x`);
    every part measures against that base tree, never against an earlier part's dump; a
    ratio over the bar is profiled per phase against the base tree and its cause fixed in
    this part. Every case of the deleted host-navigator
    test is mapped to an engine-path row or test, or named internal-only.

## 2. The last checks judged per configuration

Each check below moves out of the configuration runs. For each: counted once per key (or
once per analysis) on S at N = 1/4/8 and never inside a configuration or dead-branch run; a
fixture whose finding holds only under `!if variables.flag1` reports it labelled exactly as
the `within` analysis of each configuration does; a seeded fault forcing its condition TRUE
turns the differential red.

### 2a. Relation readers

- **Before:** these still run in each configuration: a rule condition's module calls on a
  kind's `x-telo-resource-rules` / `x-telo-referrer-rules` (`FUNCTION_*`);
  `CONTRACT_INPUTS_AT_RUN_SITE` and `CONTRACT_SLOT_INPUTS_UNSATISFIABLE`;
  `CONTEXT_FILL_CYCLE`; and a whole `!ref` supplied to a child application's need
  (`REFERENCE_KIND_MISMATCH`, `NEED_FORWARD_INCOMPATIBLE` at an `x-telo-application-source`
  resource's `needs:`).
- **After:** each is a relation reader with declared reads, judged once per relation key:
  - *rule calls* — anchored at each rule's `condition` in the kind document, reading by name
    the module functions the condition calls and onward the callables their bodies call;
    reported with the rule-absence family;
  - *reference-slot wiring* — at each reference slot, reading the resolved target's
    contract places;
  - *context fill cycles* — at the list whose entries fill a binding's members, reading the
    entries;
  - *application need references* — at each `needs:` entry holding a whole `!ref`, reading
    the declaration it names.
- **Verify:** fixtures: the callee of a rule condition declared only under a choice; a run
  site whose target's contract varies; a fill cycle closed only in one branch; a child
  application's need supplied by a `!ref` whose target varies — each labelled.

### 2b. Passes over a module's whole population

- **Before:** `IMPORT_ALIAS_SHADOWS_CONTEXT`, a referrer rule whose condition fails to
  compile, and `EXPORT_KIND_UNKNOWN` / `EXPORT_RESOURCE_UNKNOWN` run per configuration. The
  first counts a `Telo.Import` declared as a scope member as one of the module's imports, so
  a scoped import aliased like a context variable is reported though no module call can
  reach it.
- **After:**
  - **Module-call names** — one pass over every present declaration of each of the entry's
    modules (top level, extracted, scope members, forward views), each with its condition.
    A module's imports are read by one reader — the module document's `imports:` plus its
    top-level `Telo.Import` documents, never scope members — shared with the module-call
    names and the module's alias table. The names a kind's CEL contexts declare are
    conditions: the kind's own bindings TRUE, a binding inside a varying named shape under
    its class ∧ reach, each class's names computed once. A finding is one per (module,
    alias), held under the OR of the presences of the declarations whose kind puts the alias
    in scope; its wording names the kind of the first present such declaration in source
    order (declaration i under Pi ∧ ¬(P1 ∨ … ∨ Pi−1)), the plain driver choosing the same.
  - **A referrer rule's condition that does not compile** — judged once, held where a
    resource of the kind is declared, its example the first present such declaration in
    source order, once per (kind, code).
  - **Exports** — one pass over the conditioned name index: an entry naming nothing holds
    where no declaration of that name is present.
- **Verify:**
  - Kinds A and B both put `Billing` in scope, their declarations under the two branches of
    `!if variables.flag1` → two wordings, each labelled as `within` gives it; a fault
    forcing Pi to TRUE turns the differential red; a fault taking list order turns red a
    fixture whose list order differs from its written order.
  - A scoped `Telo.Import` aliased like a context variable → no
    `IMPORT_ALIAS_SHADOWS_CONTEXT`; a top-level one still gets it.
  - A context binding inside a named shape varying under `flag1` → the finding labelled; the
    kind's own bindings unlabelled; each class's names computed once at N = 1/4/8; a fault
    taking reach as TRUE turns it red; no context walk counted in any run.
  - An export naming a resource declared only under `flag1` → `EXPORT_RESOURCE_UNKNOWN`
    labelled `(when variables.flag1 is false)`.

### 2c. Callable data

- **Before:** `CALLABLE_REFERENCE_NOT_DATA` runs per configuration.
- **After:** one pass over the conditioned call graph, once over its connectives. Each node's
  own verdict (an expression whose eval mode is neither `compile` nor `accessor`, a present
  `x-telo-scope` field, a need or a fulfilment) is read once per chain of its options. The
  walk follows the graph's edges at reference sites, scope first, through the conditioned
  name index; within each node, sites in order against the condition still uncovered; one
  memo per node, except a cycle's results. A template body is judged unit by unit; a
  library's side is judged once per library under TRUE and continues at the references an
  import supplies into the union's node verdicts.
- **Verify:** a native function's data slot naming a resource that holds a runtime-eval
  expression only under `!if variables.flag1` → labelled `(when variables.flag1 is true)`; a
  two-hop chain whose first finding differs per branch → two wordings; a cycle under a
  choice; a library input supplied with a varying declaration → import-anchored, labelled.
  Faults: an edge condition forced TRUE turns the differential red; ignoring the uncovered
  condition turns the expectations red.

### 2d. Passes over the call graph

- **Before:** `CO_REFERRER_SCOPED`, `X_TELO_REF_DYNAMIC_SELECTOR`, and the never-run half of
  `OBSERVED_STATE_NEVER_RUN` run per configuration.
- **After:** each reads the conditioned call graph:
  - *scoped co-referrers* — the graph carries each node's scope, scope owner and site, and
    the lifetime of a scoped import's instance (from its members' presence); a finding also
    names the scoped import kinds it involves;
  - *dynamic selectors* — every edge whose use a dynamic selector decides is reported where
    the edge holds; the graph is the one reader of use selectors;
  - *never run* — a CEL key emits a candidate naming its resolved target; a cover removes the
    candidate wherever the target is reached by a control-transferring route from a root
    (a fixpoint over the graph's connectives; an injected declaration counts as reached).
- **Verify:** a scope member co-referrer under `!if variables.flag1` labelled; a scoped
  import's instance whose target outlives it reported only where the import is present; a
  dynamic selector in one branch labelled; a target started only where `flag1` holds → the
  never-run finding labelled `(when variables.flag1 is false)`. Faults: an edge condition
  forced TRUE turns the differential red; the reach cover forced FALSE turns the never-run
  fixture red.

### 2e. What a consumer's expansion of a template body refuses

- **Before:** the refusals of a consumer's expansion of a templated kind's body
  (`REPEAT_COMPUTED`, an open or refused expansion, a duplicate key) and
  `TEMPLATE_TARGET_UNKNOWN` / `TEMPLATE_TARGETS_CAPABILITY` are reported from each
  configuration's run.
- **After:** the expansion lifted over all configurations carries each report's holding. The
  targets findings hold where no refusal of the same expansion holds. Each finding is
  reported once, under the consumer's condition ∧ its holding. For an imported library, the
  same expander runs over each library instance's consumers, lifted over the entry's
  configurations; a library value is read through the import's binding (a literal fact, a
  bare chain naming the importer's dimension, else open), reported at the import; an open
  binding is reported once, as `BRANCH_UNDECIDABLE`. The kernel's expander stays unlifted.
- **Verify:** a computed `!for-each` source in a consumer only under `!if variables.flag1` →
  `REPEAT_COMPUTED` labelled; a targets problem in a branch with no refusal → labelled; a
  library consumer value chained through the binding to the entry's dimension →
  import-anchored and labelled; an open binding → only `BRANCH_UNDECIDABLE`. Fault: holding
  forced TRUE turns the differential red. The consumer expander runs in no configuration
  run (counter).
- The last change of this part also shows every configuration run and dead-branch run
  emitting zero findings across the corpus and the generated corpus (counter) — part 3's
  precondition.

## 3. Delete the per-configuration loop

- **Before:** beside the analysis over all configurations, `telo check` still enumerates
  configurations and runs each, and runs each branch no configuration takes, to normalize
  and to feed the parity oracles.
- **After:** no production code iterates configurations: the configuration run loop, the
  dead-branch loop and the configuration enumeration in choice reading are deleted; the
  differential's configuration list moves into the tests. The plain driver stays only for
  manifests with no choices and no template constructs, and as the differential's oracle.
  The unused, exported `requiredWhenOf` goes with the enumeration. Nothing reads a varying
  named shape's content except through the named-shape reader. This part's fragment says
  checks are no longer repeated per configuration, nor per way of deciding a template
  definition's own choices, so a manifest or a template body with many independent choices
  costs about what one with a few does. The
  cost-model paragraph of `docs/guides/choosing-by-configuration.md` states the cost model,
  and the analyzer guide's *Choices and configurations* text is rewritten to match.
- **After (cost where nothing varies):** the stages the analysis over all configurations
  added do no per-declaration work beyond what the checks they replaced did: a stage whose
  every condition is TRUE does the plain work once, and a fact of a definition or a shape is
  computed once per distinct definition or key, never per declaration — a definition's CEL
  eval sites in forward-view building and the structural keys regions and key parts intern
  included. The overhead is removed in the stages the profile names: own-key judging (union
  plan, schema-findings judge), relation anchors (census shapes), regions, own-site solve,
  placement, text findings and the conditioned call graph. The per-resource eval-path and
  context walks, unchanged since the baseline, are not changed by this plan.
- **Verify:**
  - The run counter reports 0 configuration runs and 0 dead-branch runs; no production module
    refers to the enumeration (an import-boundary test).
  - A grep test and a counter: nothing reads a registered or announced copy of a varying
    named shape, by id or otherwise, outside the named-shape reader.
  - V and S: t(8)/t(4) ≤ 2.5 and t(16)/t(8) ≤ 2.5.
  - The chain gate's stop at the first configuration or dead-branch run is removed: C(k) at
    k = 1/4/8/16 is analysed whole, k = 16 completes with 0 configuration runs and 0
    dead-branch runs, and 1b's and 1c's counter rows hold over the whole analysis. C(k): the
    whole `telo check` t(8)/t(4) ≤ 2.5 and t(16)/t(8) ≤ 2.5. 1g's table no longer lists the
    configuration list or the condition over it.
  - `telo check` at N = 16 ≤ 2 × N = 1; a cold `telo run` at N = 8 ≤ 2 × N = 1.
  - The signature bench (`reached` and `isolated`, median of 10): no choice ≤ 1.05 × the tree
    before this part; one configuration ≤ 1.5 × no choice at 300 and at 3,000 resources, the
    two ratios within 10% of each other; at 1/2/4/8/16 configurations each doubling's
    increment ≤ 1.25 × the first doubling's, or ≤ 2% of the one-configuration time,
    whichever is larger. A seeded per-configuration cost (one plain pass per configuration
    put back) fails the slope row.
  - N definitions each holding `!if variables.flagK` in their body: t(16)/t(8) ≤ 2.5.
  - Part 0's sweep rows still hold.
  - `forEachIterations` `telo check`, against the baseline on the same host: per-item time
    (t(1000) − t(100)) / 900 at most the baseline's, and t(1000) at most the baseline's.
  - The per-stage table at N = 100 and N = 1000 recorded in the change's report; any listed
    stage still carrying per-declaration overhead is fixed in this part.
  - `within` at the first full configuration ≤ the whole analysis at N = 1/4/8/16.
  - Expectations byte-identical; differential green.

## 4. Template-body gaps

### 4a. A template's `inputs:` against an entry contract derived from the entry

- **Before:** `TEMPLATE_TARGET_MISMATCH` is never reported when the dispatched entry kind's
  `inputType` is `x-telo-value-schema-from` / `x-telo-schema-projection-from` over the entry
  (the `ui` kinds' `inputType: { x-telo-value-schema-from: inputModel }`). `model: !ref
  Count`, a crossing `/model/shape` into a module declaration, and `model: !ref <sibling
  entry>` all pass with a refused value.
- **After:** the call site's contract resolution resolves the entry's references through the
  template body's own lookup (siblings, then the defining module, `<Alias>.<name>` through
  its imports). The static slot check and the kernel's creation-time decode of `inputs:`
  change together.
- **Verify:** a generated fixture with the three forms, each `inputs:` writing a refused
  value, reports `TEMPLATE_TARGET_MISMATCH` at `inputs.<field>`; none before. A
  `tests/check-run-agreement.yaml` row: refused at check, `runFails:` as the kernel prints
  it. Run the kernel side first to confirm what it refuses today.

### 4b. A body entry's reference to a resource of the wrong kind

- **Before:** a `Telo.Definition` whose `resources:` entry holds `src: !ref thing`, `thing` a
  `Self.User`, where the slot's `x-telo-ref` wants `Self.Thing`, passes `telo check`.
- **After:** `REFERENCE_KIND_MISMATCH` at the entry's slot, as for a top-level declaration.
- **Verify:** the fixture reports it; a `tests/check-run-agreement.yaml` row records what the
  kernel does at creation.

### 4c. A forward view and the kernel's `self` fill defaults by one rule

- **Before:** where an instance leaves a field out, three readers decide which schema
  `default:` fills it, and they disagree. Resource validation fills at `properties` and
  object `items`, through `$ref` and `allOf`. A template body's `self` fills `properties`
  and `items` and never crosses a `$ref` or an `allOf`. A consumer's forward view fills only
  where a forwarded path's own segment is missing, through `properties` alone: a value the
  consumer writes in part and the body forwards whole (`storage: !cel "self.storage"` over
  `storage: { engine: wal }`) reaches the entry without the defaults beneath it, and so does
  a forwarded list whose items declare defaults. A rule on the entry reading such a field
  fails to evaluate (`no such key '…'`) and is reported as `RESOURCE_RULE_INVALID`, blaming
  the rule, while the boot refuses the manifest under the rule's own code. A rule over a
  subject that lacks a property its kind's schema requires fails the same way, beside the
  `SCHEMA_VIOLATION` that already reports the subject. The direct shape — a scalar field
  defaulted under `properties` — already agrees and is pinned by `wrappedTableNotInSchema` in
  `modules/graph-sql/tests/static-refusals.yaml`.
- **After:** one rule fills a template's `self`: the positions resource validation fills
  (`properties` and object `items`, through `$ref` and `allOf`, never inside `anyOf` /
  `oneOf` / `not` / `if`), beneath a value the instance writes as beneath one it leaves out,
  each default decoded as its literal would be. One browser-safe reader in the analyzer
  implements it, and the kernel's `self`, the instance-type default filler and every read of
  `self` a forward view makes — a bare forward at its end as well as along it, a forward
  through a `base:` child, a `!for-each` element's binding, a nested view's holder — read
  through it. A read past a reference into another declaration reads that declaration as
  written, in both halves, unchanged. A resource rule is not evaluated on a subject lacking a
  property its kind's schema requires where one of the rule's read chains passes; the
  subject's `SCHEMA_VIOLATION` is the finding.
- **Verify:**
  - A vector set, kept as data: for each schema and value pair (`properties`, object
    `items`, `$ref`, `allOf`, a default inside a union branch, a default beneath a filled
    default), the reader's result equals the validator's `useDefaults` result.
  - Analyzer fixtures over invented kinds, recorded first on the current tree, each with a
    resource rule over the defaulted field: a whole forwarded object the consumer writes in
    part, a forwarded list whose items declare defaults, a default beneath a `$ref` to the
    library's named shape, one beneath an `allOf` member, one reached through a `base:` child
    of the templated kind, one through a nested templated kind, and one through a
    `!for-each` element. Each reports one `RESOURCE_RULE_VIOLATED` naming the body entry and
    no `RESOURCE_RULE_INVALID`.
  - `modules/graph-sql/tests/static-refusals.yaml` gains a whole-object row and a `$ref`
    row beside `wrappedTableNotInSchema`. Each reports `RESOURCE_RULE_VIOLATED` with rule
    `GRAPH_TABLE_NOT_IN_SCHEMA` and `runFails:` the kernel's refusal under that code, so
    `telo check` and the kernel's `self` agree.
  - A seeded fault restoring a properties-only reader in either half turns the
    whole-object and `$ref` rows red.
  - A consumer omitting a required forwarded field with no default, and a top-level
    resource missing a required field its kind's rule reads, each report `SCHEMA_VIOLATION`
    and no `RESOURCE_RULE_INVALID`.
  - The corpus dump lists every changed finding; the differential stays green.

### 4e. The end-to-end import test of the kernel's configuration view

- **Before:** a library kind whose `schema:` `$ref`s its own unexported named shape checks
  and boots (pinned by a `tests/check-run-agreement.yaml` row), but the kernel's
  configuration view over such an import has no end-to-end test; with a shape that does
  not vary, no such test can be red, and a varying one is refused until 1c.
- **After:** an application imports the library twice, one alias under `whole: true` and
  one under `whole: false`; the library's shape varies the eval mode of `amount`, and a
  templated kind reads `self.price.amount` in a body step. Each instance's result is
  asserted with `Assert.Equals`, the two differing because they read different classes.
  Built on 1c.
- **Verify:** the test is red under each of two seeded faults — a child import inheriting
  the root's view, and both imports reading the first import's view — and green without
  them.

## Known defects found along the way

Found while building the rest; none is part of the work above, each reproduces on the
released tree unless stated.

- A named shape whose whole `schema:` is an `!if` holding a `$ref` to the `Text` fragment
  crashes at registration.
- `UI_FILTER_DUPLICATE`'s rule reads `property` without a presence guard.
- 22 dependency-verdict fixtures fail the rust-parity sweep at the base.
- `templating/nodejs/tests/module-call.test.ts` fails to type-check at line 199.

## Order

0 → 1a → 1b → 1c → 4e → 4c → 1d → 1e → 1f → 1g → 2a → 2b → 2c → 2d → 2e → 3. 1h is built inside
1c, at the place below. Part 4 is independent of the rest, except 4e, which rests on 1c. 1c
is built by family: own-check schema keys (introducing the instance-keyed reader) → the
`SCHEMA_IN_PLACE_CYCLE` refusal → the schema carve → relation keys → the two 1g stages that
stop C(8) before its first configuration run (the conditioned call graph's cut-point
readings, and `EVAL_MODE_BRANCH_CONFLICT`'s pair verdicts, memoised by (position pair, class
pair)) → the engine's `schemaDependencies` → the engine's schema-declared namespace results,
own-type agreement, and the node each verdict was read from and the origins of each result
(`schemaNode`, `resultOrigins`) → the engine's null and union typing, in both engines with
their conformance rows: a resolver's type name read as a type expression; a proven chain
narrowed wherever it is read, every plain chain a subject, a proof dropped beneath a
rebinding, `map/3`'s transform under its predicate, `has()` a proof of a member; the join
with null and with an including union; `==` / `!=` / list `in` over a nullable operand on
its non-null part; a member only some union branches declare reported once → the engine's
schema and union reading, in both engines with their conformance rows: a record's undeclared
members typed by its `additionalProperties` (`additionalFields`), an open record standing
where a string-keyed map does, `not` read, a tuple's positions read (`prefixElements`), a
call or operator over a union resolved member by member within `UNION_EXPANSION_LIMIT`,
asked only where an overload of the call's name and form has its arity,
equality and membership by overlap and against `null`, a type parameter bound at several
arguments taking their join, a type test narrowing a chain, a comprehension over a union of
lists and maps → the intersection's member nodes, in both engines with their conformance
rows: at every member position of a container a meet builds — a record's field or undeclared
members, a list's element, a tuple's position or rest, a map's value — a member exactly one
part types other than `dyn` is placed at that part's node, one several parts type is placed
nowhere and its read lists each declaring node, a declared-absent member is placed at the
first part declaring it absent; two equal unions meet member by member at matching
positions, so the met type equals each part's and a member nested in one is placed by the
same rule; and a read reaching an intersection lists what the meet compared — each part's
own type, the node of each part holding a position as `dyn`, and where several parts type a
position other than `dyn` each of those nodes and the positions beneath it — never every
part whole; and the meet is linear in the depth of the shapes it composes, per conversion and
in both engines: each holder is interned by the side, member and typing it stands for, a
member's holders are kept canonical (each distinct holder in first-occurrence order, held at
most twice); unique table: every type a meet builds is interned per conversion, a container
keyed by its kind, the identities of its members (fields, element, value, positions, rest,
pattern parts), `fieldEnums`, `absentFields`, `additionalFields`, for each member its
canonical holder list, and for each absent name its canonical holder list and whether some
part declares it absent, and a union by its members' identities in order — the key covers
every side-table entry that placement or the listing reads, and a second meet producing an
equal key answers the interned type; each meet is answered once per (left, right,
orientation), a repeat pushing the one reading its comparison recorded where the meet would
have pushed it and marking again a pass past `UNION_EXPANSION_LIMIT`; an interned union is
never placed: each node read whose own type is a union a meet built places a shallow copy of
it at that node, at most `UNION_EXPANSION_LIMIT` members once per node read, and containers
built by a meet keep the interned union; a joined reading holds its parts rather than a copy,
listed and read once per check in the order the copy would be; a walk over a type visits
each distinct type object once — type graphs are shared, a reference read once and a meet's
results interned, so every whole-type walk in either engine memoizes by identity for the
duration of the call: one-type walks (`withoutParameters`, `holdsOptional`, their Rust twins,
and every other walk of that class) answer each type object once; equality, assignability and
the join answer at once when both sides are the same object, and answer each identity pair
once; the meet answers each identity pair once, through the computed table, and never answers
at once on the same object — a member that several parts type, including equal parts and one
shape reached twice, is placed nowhere, so a type met with itself is not the type alone; and the
environment digest's writer writes each distinct type once and refers back to it after that
(type graphs hold no cycle, recursion being the declared `dyn`, so a memo of results is
enough); a printed type is written whole up to `TYPE_TEXT_NODE_LIMIT` type nodes, then cut —
the limit 64, declared as data beside the union expansion limit and read by both engines,
printing walking the type in pre-order (a union's members in order, a container's arguments in
order, a record as its one name), each type node written counting one, the node that would
exceed the limit written `...` and printing stopping there, every open bracket closed — so the
text is bounded by the limit and the depth, whatever the type's size, and one formatter serves
`typeName` / `format_type` in both engines and every message that names a type, while nothing
reads a printed type back as a type; a printed type is display only, and nothing decides behaviour from it — no parse, no
equality, no lookup keyed by it, a one-node name included; a reader that branches on a type
reads the CEL type: its `kind`, and the engine's own predicates and registry — a type read from
type-expression text (a signature, a parameter, a declared variable) is a tree linear in that
text, so `exactTypeText` / `exact_type_text` writes it whole, its identity in a signature's text,
a dispatch key and the environment listing; a type converted from a schema has no printed
identity, the environment digest's writer identifying it (each distinct type written once with
back-references) and the cut formatter displaying it, the namespace listing's `name(…):
<returns>` line for a result declared as a schema included, `NamespaceListing.functions`
listing each function as `{ declaration, resultType? }` and the digest reading `resultType`
structurally; an `!interpolate` hole converting exactly when `string(<hole type>)` resolves in
the site's environment, asked through the registry; a named type's arguments are
compared as types (`typesEqual` / `types_equal`, invariant, memoized), never by printed text;
and `ResolvedCall.argumentTypes` holds each namespaced call argument's type, the text moving to
`argumentTypeNames`, templating's call list carrying both and the analyzer's module-call check
reading the root of the type itself; and on the diamond whose every level meets the level below with itself, on two chains of equal
content each level meeting both below, and on a diamond each half of which is a union of two
shapes, the holders kept, the containers built and the reading entries built each satisfy
c(32) ≤ 2.5·c(16) and c(16) ≤ 2.5·c(8), as do the reading entries listing `x.a…a.v` steps
through on the first two, and on the binary shared schema the type visits a check of `x` and of
`x.a.b.a` performs, conversion included, satisfy v(24) ≤ 2.5·v(12) and v(48) ≤ 2.5·v(24), a
check of `x` at depth 64 completing, and on the `oneOf` array/object diamond the text a check
of `x` prints at depths 16, 32 and 64 writes `TYPE_TEXT_NODE_LIMIT` type nodes and one `...`
→ the engine's `patternProperties` reading (`patternParts`), absence for every
member meet that cannot hold, and the computed-key union, in both engines
with their conformance rows → 1h: CEL sites typed by the engine to full depth through its resolver,
each reference answered by the key's shape lookup as today, the host walks that decided
member, operand and nullability verdicts deleted, every finding it changes listed → the
engine's discriminant narrowing (`fieldEnums`), the union join widening by kin, and the
check's `assumptions`, in both engines with their conformance rows → the analyzer's step
guards handed to the engine as assumptions → the corpus's newly refused manifests fixed →
CEL keys' late split and the shared function index's lazy signatures, deleting the CEL family's
fold → contract shapes (deleting what is left of the fold) → library shapes and the kernel
half.

## Release

- A fragment per user-visible change, through `telo release add`, on the units it changes
  (`analyzer`, plus `kernel` / `templating` where their half changes); each listed Surface
  change and each newly reported finding named in it; an `Added` fragment on `cel` for
  `schemaDependencies`, schema-declared namespace results, own-type agreement and
  `schemaNode` / `resultOrigins`; an `Added` fragment on `cel` for the schema and union
  reading (record `additionalFields` replacing `open`, the break described in its body, list
  `prefixElements`, union expansion with its limit, equality by overlap, type-test
  narrowing, `not` and tuple reading); an `Added` fragment on `cel` for `fieldEnums`,
  discriminant narrowing, the union join by kin and `assumptions`; an `Added` fragment on
  `analyzer` for step-guard narrowing and the union-typed slot fit (which may newly refuse a
  union-typed value at a slot one of its members does not fit); an `Added` fragment on `cel`
  for the null and union typing, saying some expressions that were refused now check and that a manifest that
  checked clean may now be refused (an unguarded dereference of a comprehension variable's
  nullable member, a member only some union shapes declare) because the read can fail when
  it runs; an `Added` fragment on `analyzer` and `templating` for
  1h, naming the newly reported findings, `CEL_SCHEMA_UNJUDGED`, the slot fit over origins
  and the `Telo.Import` withheld-binding wording, and saying a manifest that checked clean may now be refused at check and at load
  because the operation it holds fails when it runs; a `kernel` `Fixed` fragment only if the
  `base:` mapping's `self` binding has to change; `ERR_REFERENCE_KIND_MISMATCH` for a
  contract or signature `!ref` naming a non-shape and the scoped-import host-path checks
  named in the 1h `analyzer` / `kernel` fragment; `patternParts`, absence for every member
  meet that cannot hold and the computed-key union in the `cel` schema-reading fragment; an `Added` fragment on `analyzer` and `kernel` for
  `SCHEMA_IN_PLACE_CYCLE` / `ERR_SCHEMA_IN_PLACE_CYCLE`, saying the check used to crash on
  such a schema. A `Telo.Import`'s inputs now accept `!if` / `!switch` and the module-file tags
  (`!module-path`, `!include-text`, `!include-bytes`), which
  widens the grammar: `telo release floor` is run on every module that adopts it, in the
  same change.
- Fragments for 4c on `kernel` (`self` now holds defaults beneath `$ref` / `allOf`) and
  `analyzer` (forward views and rules); the kernel guide, `docs/extend/templated-definitions.md`
  and the authoring primer state the one default rule.
- `docs/reference/diagnostics.md` rows for new or reworded refusals.
- `analyzer/nodejs/CLAUDE.md` and `kernel/nodejs/CLAUDE.md` updated where the mechanism they
  describe changes, the authoring agent's primer where a refusal it teaches changes (a named
  shape refers to itself only beneath a property or an item; how `self` and step results are
  typed in a body); the templating guide's CEL verdict section (the engine judges members,
  templating only phrases the message).
