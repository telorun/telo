# Template expansion — `!for-each`, `!if`, `!switch` and configurations

## Problem

Before: a template body declares a fixed list of literal entries, and every
entry is created when the instance initializes. A manifest likewise creates
every resource it declares and requires every input that has no `default:`.
Three things cannot be expressed:

- **N things from a list.** A blueprint can hand a consumer's list to ONE entry
  that already takes a list (`Http.Api` `routes:`, `Ai.Tools` `tools:`), but
  cannot turn a list into N resources. Blocked: ScheduledJobs (a map of jobs
  becomes N `Scheduler.Cron`), Webhooks (N routes in one `Http.Api`, each
  handler wrapped in its own `Idempotency.Once`), CRUD from tables (one
  `Crud.Resource` per table of a declared schema).
- **Presence and choice decided by configuration.** A kind with `port` and
  `adminPort` cannot run one server with two mounts when they are equal and two
  servers when they differ.
- **One application, several backends, chosen by the environment.** An app
  cannot start on SQLite or PostgreSQL, or on OpenAI or Anthropic, depending on
  what its environment supplies: declaring both connections creates both, and
  declaring both API keys requires both.

**The governing requirement:** `telo check` checks every path, the analyzer
knows the topology of every way the application can start, and no manifest
defect surfaces after boot. Every rule below follows from it: whatever cannot
be enumerated before boot is refused.

This builds on the `needs:` block and the `Telo.Url` value type, both already
in place; only the section "Over `needs:`" and the second projection use them.
The database example also uses `Telo.DurableDirectory`, one of the
kernel-declared need types still to land: that example runs once it exists,
and nothing else here waits for it.

## The three tags

| Tag | Valid at | Emits |
|---|---|---|
| `!for-each { in, emit }` | an item of any list inside a template body | one list item per element |
| `!if { if, then, else? }` | an item of any list; the value of any field; an entry of a template body's `resources:`; a whole document | the chosen branch, or nothing |
| `!switch { switch, cases, default? }` | the same positions as `!if` | the chosen case, or the `default:` |

A tag is expanded before any other check reads the manifest, so no host schema
admits it and every downstream pass — schema, references, CEL typing, call
graph, zones, throws, rules — runs over the expanded manifest. The loader turns
each tag into a sentinel, as it does `!ref`, in both templating halves (Node
and Rust). The keys are the step grammar's (`if` / `then` / `else`, `switch` /
`cases` / `default`); the tag is what tells the two apart — a step's `if:` is
decided per call, `!if` before boot. Conditions and selectors are written
behind `!cel`, or as literals.

### `!for-each`

- **Template body only** (`REPEAT_OUTSIDE_TEMPLATE`). Its source is the
  consumer's literal data, which only a template receives.
- **List items only.** It emits one item per element, concatenated with the
  literal items around it in declaration order. Directly in `resources:` it is
  refused (`REPEAT_UNREACHABLE`): nothing can `!ref` an emitted entry. Emitted
  items are unnamed inline declarations. One element needing several resources
  that refer to each other emits one inline `Self.<Unit>` of a templated kind
  whose own body names its parts literally.
- **The source is a typed collection.** `in:` is a bare `self.<path>` or
  `item.<path>` whose schema is an array or a map (`additionalProperties` /
  `patternProperties`) — a scalar, an open value or a union is
  `REPEAT_SOURCE_INVALID`, at the definition.
- **The source is literal.** The consumer's collection must
  be literal in their manifest, through any chain of bare `self.` forwards; a
  computed one is `REPEAT_COMPUTED`, at the consumer's key. Element VALUES may
  hold CEL. A list taken from the environment has a length nobody knows before
  boot, so no configuration (below) can stand in for it.
- **The path may cross a reference into a declaration** — `self.schema.tables`,
  where `schema` is a `!ref` to the consumer's schema resource, reads that
  declaration's `tables:` as written; the rest of the path must be literal there
  too (`REPEAT_COMPUTED`, at the declaration). Both halves read the
  declaration, never a published reading.
- **Bindings**: `item` is the element, typed as the source's `items` or map
  value schema, plus `key` (`string`) for a map source or `index` (`int`) for a
  list source; there is no `as:`. They are constants for the instance's
  life and in scope in every expression inside the emitted item, including ones
  evaluated later (a route's `inputs:` may read `item.secret` beside
  `request.body`). They are not bound on the instance's child context — every
  emitted item shares it, often inside one resource — so expansion closes each
  expression left compiled inside an emitted item over that item's own
  `item` / `key` / `index`.
- **Innermost binding wins.** A nested `!for-each` shadows the outer `item`,
  and so does an emitted item's own kind wherever it binds the same name (an
  iteration step's `item`). A named binding (`x-telo-bindings-from`) called
  `item`, `key` or `index` inside an emitted item is `BINDING_NAME_RESERVED`.
- **Forwarding is today's rule**: a bare `!cel "item.<path>"` forwards the value
  untouched, references included, exactly as `self.<path>` does; any other
  expression yields data, and a computed value at a reference slot is
  `REF_SLOT_COMPUTED`. The template's schema marks every reference slot under
  the element with `x-telo-ref`.
- **A map source may not have integer-like keys** (`"1"`, `"2024"`):
  `REPEAT_NUMERIC_KEY`, at the consumer's key. A JavaScript object puts such
  keys first in numeric order whatever order they were written in, and the Rust
  half's order depends on its map type, so declaration order — which decides
  `targets:` start order — would differ from what the author wrote.
- **`emit:` is held to the item schema of the list it sits in**, as a literal
  item there would be; in a templated `targets:`, each emitted declaration is
  also judged by `TEMPLATE_TARGETS_CAPABILITY`.
- **Names and order**: emitted items are named from the source — by key for a
  map (`jobs.nightly`), by index for a list — and follow the consumer's
  declaration order. An empty collection emits nothing.

### `!if` and `!switch`

- **In a list**, the chosen branch is one item (or none); **as a field's
  value**, it is the field's value, and no branch removes the key — so a
  field-value `!if` requires `else:` (`BRANCH_SHAPE_INVALID`). Each branch is
  held to the schema of the position it fills, in every configuration that
  selects it.
- **As a `resources:` entry or a whole document** — a declaration position —
  the tag carries the declaration's `metadata`, and every branch is one
  unnamed declaration, `{ kind, …fields }`, the shape an inline declaration has
  at a slot. In each configuration the choice expands to one declaration: the
  chosen branch's `kind` and fields under the tag's `metadata`. The name is
  written once, on the tag, so the module's name table is the same in every
  configuration: `DUPLICATE_RESOURCE_NAME`, `INVALID_NAME`,
  `NAME_CASE_CONVENTION` and, in a template body, `TEMPLATE_ENTRY_NAME_DYNAMIC`
  judge the tag's `metadata.name` once, with no configuration label, and rename,
  go-to-definition, `exports.resources` and the module graph's row identity read
  one site. Only the kind behind the name, or whether it exists, varies. An
  `!if` with no `else:` there declares a resource that exists in some
  configurations only; a reference to it from where it does not exist is the
  ordinary unresolved-reference diagnostic, reported for those configurations.
- **A branch at a declaration position** is one unnamed declaration of a
  resource kind, or a nested `!if` / `!switch` whose branches are — never a
  branch carrying `metadata`, a module doc, a `Telo.Definition`,
  `Telo.Abstract` or `Telo.NeedType`, an import, a list or a scalar
  (`BRANCH_CASE_INVALID`). A nested tag carries no `metadata`: the outermost
  tag holds the identity.
- **Inline when used once, a declaration-position choice when named.** A
  resource used once is a value-position choice at its slot
  (`connection: !if { … }`); it becomes a declaration-position choice only when
  something must name it — the rule a plain resource follows.
- **The tag's own mapping has a grammar**, two forms per tag: the value form
  (`if` / `then` / `else?`, `switch` / `cases` / `default?`) and the
  declaration form (the value form plus a required `metadata`). Both are
  built-in entries in `sdk/builtins/`, read by both analyzers and both loaders.
  An unknown key (`thne:`), a missing required key, `metadata` missing at a
  declaration position, or `metadata` anywhere else — a value position or a
  nested tag — is `BRANCH_SHAPE_INVALID`.
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
  `BRANCH_CASE_KEY_INVALID`, at the key. In a configuration where no case
  matches and there is no `default:`: `BRANCH_NOT_EXHAUSTIVE`, naming the
  configuration and the value. A well-typed case no configuration selects is
  `BRANCH_CASE_UNREACHABLE`, a warning — it is still checked.
- **`if:` evaluates to a boolean.**
- Branches nest inside each other and inside `!for-each`, in either order.

## Decidability

A condition or selector must be decidable before boot. Each name it reads must
resolve to one of:

- a literal — in the template's consumer, through any chain of bare `self.` /
  `item.` forwards;
- a **dimension**: a projection of a root input whose domain the input's
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
     `user`, `path` and `query` as well), and a non-sensitive member is
     never redacted, whatever input holds it.
  3. **Presence**: a bare input path compared with `null`
     (`!cel "secrets.openaiApiKey != null"`). Its domain is `present` |
     `absent`.

**An input admits absence** when its declaration says so: a `variables:` /
`secrets:` entry declaring `default: null`, in an Application or a Library. Its
CEL type is then nullable, so an unguarded read is `CEL_NULLABLE_ACCESS`, and
`DEFAULT_INVALID` accepts `null` there whatever its `type:`. A `ports:` entry
never admits absence. A presence test on an input that cannot be absent is
constant, so its dead branch is `BRANCH_CASE_UNREACHABLE`.

**A dimension narrows.** In a configuration where an input is `present`, it is
non-null: reading it needs no guard. In one where a `scheme` dimension holds a
value, the member is that literal.

Anything else is `BRANCH_UNDECIDABLE`, reported where the open value is
written: a consumer's computed value, any other read of an input (its whole
value when its domain is open, `secrets.databaseUrl.host`), a `ports` read,
`inputs`, `request`, `steps`, a resource's published state. The condition is
evaluated by the analyzer under the restrictions a resource rule's condition
has — no host-backed and no non-deterministic function — and one that does not
parse, does not type-check, throws, or yields the wrong type is
`BRANCH_CONDITION_INVALID`.

**A template definition is checked with no consumer too**: every branch's
content is checked against its entry kind's schema with `self` typed from the
kind's schema, and every `emit:` with `item` / `key` / `index` typed from the
source path — through a reference, from the referenced kind's schema. A typo
inside a branch nobody selects, or inside `emit:` when the template's own tests
pass an empty list, fails the template's own `telo check`.

## Configurations

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
  otherwise, each diagnostic carrying the configurations it arose in.
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
  `secrets:` entries a condition reads through one of the three projections. A
  consumer's check takes the dimensions its own bindings reach, so a library
  imported with `dialect: postgres` is checked once.
- **The analysis stamp covers every configuration**, so a warm load checks
  nothing again whichever configuration starts.
- **What is repeated** is the checks over the whole application, and the
  per-resource checks of a resource whose expansion or reach varies. Analysis
  time grows with the number of configurations for exactly those.

## Inputs required per configuration

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

## Runtime

- **Load order.** The kernel resolves every dimension first, by the usual
  precedence (supplied by name, argv, env, `default:`), and validates it
  against its schema; an input admitting absence that nothing supplies is
  `absent`. A value outside its domain — an enum value not listed, a URL whose
  scheme its `scheme` argument refuses — is `ERR_MANIFEST_VALIDATION_FAILED`
  (`Telo.Url`'s own `ERR_URL_INVALID` for a URL), naming the input and its
  allowed values,
  before any resource is created — the one refusal analysis cannot remove,
  since no check sees the environment. It then expands the documents for that
  configuration and resolves the inputs that configuration requires, under the
  same code.
- **Only the chosen branch exists.** Unchosen branches are never registered or
  created, so their kinds' controllers are never resolved, built or fetched.
- **Template bodies** are expanded at the instance's `init()`, where the body is
  registered today, for the running configuration.
- `Kernel.Starting` carries `{ telo, configuration }`, the dimension values the
  process started with.
- **Reload** rebuilds a template instance whole, as any template field change
  does today; a dimension change needs a restart, since its value comes from
  the process's inputs. A manifest edit is reconciled over the expanded set of
  the running configuration.
- **Each error-level code has a kernel twin**, `ERR_<code>`, raised where the
  kernel first meets the defect — at load for a document, at definition
  registration for a definition, at creation for a consumer's value — so a
  dependency whose own check was never run cannot reach boot unrefused. Each
  pair is added to `tests/check-run-agreement.yaml`, pinned at the declaring
  library and at a consumer whose entry-scoped check is silent.

## Over `needs:`

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

## Diagnostics

| Code | Reported at | Meaning |
|---|---|---|
| `REPEAT_OUTSIDE_TEMPLATE` | the tag | `!for-each` outside a template body |
| `REPEAT_UNREACHABLE` | the tag | `!for-each` directly in `resources:` |
| `REPEAT_SOURCE_INVALID` | the definition | `in:` is not a bare `self.<path>` / `item.<path>`, or its schema is not an array or a map |
| `REPEAT_COMPUTED` | the consumer's key or the declaration | the source collection is not literal |
| `REPEAT_NUMERIC_KEY` | the consumer's key | a map source has an integer-like key |
| `BRANCH_UNDECIDABLE` | the open value | a condition reads an input other than through one of the three projections, or a value that is not literal |
| `BRANCH_CONDITION_INVALID` | the condition | does not parse or type-check, throws, yields the wrong type, or calls a forbidden function |
| `BRANCH_CASE_KEY_INVALID` | the case key | a case key is not a value of the selector's type |
| `BRANCH_NOT_EXHAUSTIVE` | the `!switch` | a configuration selects no case and there is no `default:` |
| `BRANCH_CASE_UNREACHABLE` | the case (warning) | no configuration selects it |
| `BRANCH_CASE_INVALID` | the branch | at a declaration position, a branch is not one unnamed resource declaration (or a nested choice whose branches are) |
| `BRANCH_SHAPE_INVALID` | the tag | the tag's mapping does not fit its grammar: an unknown or missing key, a field-value `!if` without `else:`, `metadata` missing at a declaration position, or `metadata` anywhere else |

## Examples

Import sources are written as an in-repo manifest under `tests/` reaches them.

**A backend is chosen by the environment through the presence of the chosen
backend's own input.** Each alternative stays a typed input, so the needs
report tells whoever provisions the app what each configuration takes. An app
for which a missing input must be refused rather than fall back keeps an
`enum` selector variable instead.

### A database chosen by the environment

This one uses "Over `needs:`" above, and `Telo.DurableDirectory`, so it runs
once that kernel-declared type lands. `resources.databaseAccess` is a presence
dimension, so `telo check` checks two configurations. The tag declares `db`
and each branch only its kind, so every `!ref db` reaches whichever was
chosen. Inside the `then:`
branch the optional need is proven present, so `access: !ref databaseAccess` is
legal there. `data` is reached only in the `else:` branch, so it is required
only when `DATABASE_URL` is unset.

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

### A model provider chosen by the environment

The same pattern for `Ai.Model`, with a secret. `openaiApiKey` declares
`default: null`, so it may be absent and its presence picks OpenAI;
`anthropicApiKey` is read only in the `else:` branch, so it is required only
when `OPENAI_API_KEY` is unset. The tag names `model`, and each branch is one
unnamed declaration; what it alone uses is declared inline beneath it. When both keys are set, OpenAI is used, as the
condition says.

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

### One list into N resources — ScheduledJobs

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
targets:
  - !for-each
    in: !cel "self.jobs"
    emit:
      kind: Scheduler.Cron
      cron: !cel "item.cron"
      invoke: !cel "item.invoke"
```

The consumer lists its jobs literally; a malformed `cron` is reported at
`jobs.nightlyReport.cron`, and `jobs: !cel "variables.jobs"` is
`REPEAT_COMPUTED`.

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

### One list into one entry's list — Webhooks

Every emitted route lands in the one `Http.Api`. `key` and `item` are
constants of the element, read beside the per-request `request`.

```yaml
resources:
  - kind: Http.Api
    metadata: { name: api }
    routes:
      - !for-each
        in: !cel "self.webhooks"
        emit:
          request:
            path: !interpolate "/hooks/${{ key }}"
            method: POST
          inputs:
            source: !cel "key"
            event: !cel "request.body"
          handler: !cel "item.handler"
          returns:
            - status: 202
```

### Presence decided by configuration — one server or two

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

## `targets:` widening

A templated `Telo.Service` / `Telo.Runnable`'s `targets:` accepts, beside
`!ref <entry>`, an inline declaration, a `!for-each` item and an `!if` /
`!switch` item — ScheduledJobs is
`targets: [!ref server, !for-each { in: !cel "self.jobs", emit: { kind: Scheduler.Cron, … } }]`.
An Application's `targets:` accepts `!if` / `!switch` items.

## `Crud.Resource` over a declared table

- **`table:` also accepts a `!ref` to an `Sql.Table`** — a union of today's
  name string and a reference branch, so every existing manifest keeps working.
  Given a reference, the physical table name is that table's `table:`, and the
  data shape is the table's projected row schema with the `id` column removed.
- **`model:` beside a referenced `table:` is refused**
  (`CRUD_MODEL_WITH_TABLE_REF`, a resource rule, with its kernel twin): two
  sources of one shape would drift, and the table is the one the database is
  built from.
- **The API stays camelCase**: CRUD applies the snake_case ↔ camelCase
  conversion it already applies to `model:` properties.
- **The projected row schema reaches the template body as a value**, because
  CRUD writes it into its `Http.Api` request schemas and OpenAPI document — the
  same projection `telo check` and dispatch already compute.

## Blueprints

Three new blueprints, each with an `example/` and `tests/`:
`blueprints/scheduled-jobs-app` (a map of jobs, one `Scheduler.Cron` each),
`blueprints/webhook-app` (one `Http.Api`, one route per webhook, each handler
in its own `Idempotency.Once` behind a shared-secret check) and
`blueprints/crud-app` (a schema resource the consumer declares, one
`Crud.Resource` mounted per table).

## Editor

- The language server publishes each diagnostic with `data.configurations`
  and the labelled message.
- Studio's module graph gets a configuration picker, defaulting to each
  dimension's `default:` (a presence dimension to `absent`) and otherwise the
  first value of its domain, and draws
  the selected configuration. A branch site shows its alternatives; a
  declaration-position choice is one box identified by its name, its
  alternatives keyed by `then` / `else` / case key, and the picker changes the
  box's kind, never its identity. A `!for-each` is a repeat row inside the list
  it sits in, identified by its source path. Neither is a new kind of
  containment.
- The formatter and studio's YAML round-trip preserve all three tags and their
  mappings, writing a declaration-position tag's `metadata` first.

## Polyglot

The Rust loader turns the three tags into sentinels. The Rust kernel evaluates
no CEL, so it refuses a module containing any of them at load with the
existing `ERR_UNSUPPORTED_MANIFEST_FEATURE`, naming the tag and its line, as it
refuses `needs:`.

## Housekeeping

- **One expansion, read by both halves.** The analyzer owns the expansion and
  the configuration enumeration; the kernel reuses them, so the two cannot
  disagree about what a manifest expands to. Nothing in either names a kind.
- **Floors.** Every module whose own `telo.yaml` writes one of the tags, a
  non-`!ref` item in a templated `targets:`, or `default: null` on a
  `variables:` / `secrets:` entry, declares `requires: telo:` at the
  release that ships this, as the surface generator reports it, verified by
  running the previous published CLI against it.
- **Releases.** A changeset for the telo version line (analyzer, templating,
  kernel, CLI, language server, ide-support, SDK); a `telo release` fragment
  for `crud` and for each new blueprint.
- **Docs.** The templated-definitions guide (all three tags in bodies), a new
  guide on configurations (the three projections, narrowing, derived
  requirements, and "a backend is chosen by the environment through the
  presence of its own input"), the application-arguments spec (`requiredWhen`,
  `--help`), the needs guides (presence, per-configuration requirement, the
  report's `dimensions` and `requiredWhen`), the analyzer guide's template and
  CEL-scope sections, the kernel guide's load order, the root `CLAUDE.md`,
  `blueprints/README.md`, and the crud module's docs and README.
- **Authoring agent.** The primer gains the three tags, the decidability rule,
  the backend-by-environment pattern and the rule "inline when used once, a
  declaration-position choice when named", in the same change; the
  templated-definitions and configurations guides state the same spelling.

## Verify

- ScheduledJobs with three jobs boots; all three crons hold the app and fire.
- Webhooks produces ONE `Http.Api` and one OpenAPI document with N paths, each
  handler wrapped in its own `Idempotency.Once`; a redelivered event is
  deduplicated; two routes whose `inputs:` read `item.secret` each receive
  their own secret.
- CRUD over a schema declaring two tables serves both resources' list / read /
  create / update / delete, with both tables created before the server starts;
  adding a column adds it, camelCased, to that resource's create body and
  OpenAPI document; a `renamedFrom:` keeps its data.
- A kind with `port` and `adminPort` runs one server with two mounts when they
  are equal and two servers when they differ.
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
- A `Telo.Url` secret declaring `scheme: { enum: [a, b] }` drives a `!switch` on its
  `scheme`; a URL with scheme `c` is refused at load naming the secret and
  never printing it; a condition reading its `host` is `BRANCH_UNDECIDABLE`.
- A variable declaring `type: string, default: null` read unguarded outside a
  branch proving it present is `CEL_NULLABLE_ACCESS`, and read inside one is
  not.
- A `!switch` on a dimension with a value no case covers is
  `BRANCH_NOT_EXHAUSTIVE` from `telo check`, naming the configuration.
- A condition reading a `variables` entry declared `type: string` is
  `BRANCH_UNDECIDABLE`; `jobs: !cel "variables.jobs"` is `REPEAT_COMPUTED`; a
  map source keyed `"2024"` is `REPEAT_NUMERIC_KEY` — each with its `ERR_` twin
  in `tests/check-run-agreement.yaml`.
- A typo inside `emit:` (`crno:`) and inside a branch of a template is reported
  by `telo check` on the template alone, with no consumer.
- A `Crud.Resource` with both `model:` and a referenced `table:` gives
  `CRUD_MODEL_WITH_TABLE_REF` from `telo check` and its `ERR_` twin at boot.
- A declaration-position choice `db`: renaming it in the editor finds exactly
  one declaration site; a plain `db` beside it is `DUPLICATE_RESOURCE_NAME`
  with no `data.configurations`; a typo in a case nobody selects is reported at
  `cases.postgres.<typo>`, labelled `(when variables.dialect is postgres)`; the
  module graph shows one `db` box in every configuration, whose row identity
  survives switching the picker and adding a case.
- A `Sql.Query` outside every branch, holding `connection: !ref db` where `db`
  chooses between two connection kinds and one is refused at that slot, is
  reported labelled with that configuration only.
- A boolean `!switch` with a case `yes`, and an integer one with a case `01`,
  are `BRANCH_CASE_KEY_INVALID`; a field-value `!if` without `else:` is
  `BRANCH_SHAPE_INVALID`; `in: !cel "self.name"` on a string field is
  `REPEAT_SOURCE_INVALID`; an `emit:` that does not fit its list's item schema
  is reported at the `emit:` field — each with its `ERR_` twin.
- `metadata` on a value-position tag is `BRANCH_SHAPE_INVALID` and `metadata`
  inside a branch is `BRANCH_CASE_INVALID`, each with its `ERR_` twin in
  `tests/check-run-agreement.yaml`; the Node and Rust loaders produce the same
  sentinel for a document-root choice.
- Formatting a manifest carrying each tag, and saving it from studio, leaves
  the tags unchanged.
- The analysis time of an app combining the database and model-provider
  examples is recorded at one, two and four configurations, and only the
  whole-application checks and the per-resource checks of resources whose
  reach varies grow with the count.
- The previous published CLI refuses each adopting module with its `requires:`
  stripped, and reports `MODULE_REQUIRES_NEWER_RUNTIME` once it is restored.
