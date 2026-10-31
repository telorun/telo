# Designing a library

A `Telo.Library` is Telo's unit of reuse: an importable manifest with its own
scope, its own input contract (`variables`, `secrets`, `resources`) and an
explicit list of what importers may see (`exports`). It is the same shape
whether it sits in a sibling directory and is imported by relative path, or is
published and imported by ref. A library inside an application's (or another
library's) directory is private to it and ships inside its published artifact;
one meant for other modules lives outside it. This guide is about the design decisions — what
to export, how to make a kind, what the importer must supply — not about the
field grammar.

Take the exact schema of every kind you compose or extend, and the `imports:`
line for each module (with its version and integrity pin), from `get_kinds`.
Snippets below write an import as `<ref>@<version>#<pin>`; write what
`get_kinds` returns. A `Telo.*` kind (`Telo.Definition`, `Telo.Abstract`, a
`Telo.<Kind>` parent such as `Telo.LogSink`) and every schema fragment a kind
names is built in: `get_kinds` returns it with no import line, at the telo
version you pass as `telo` — import nothing for it. Never write a
`JS.Script`: a kind is composed from existing kinds, specialized from one, or —
for genuinely new runtime behaviour — given a controller in a module of its
own.

## Library or application

- A **`Telo.Application`** is a runnable entry point: it binds the host
  environment (`env:` / `arg:` on its `variables`, `secrets`, `ports`), owns
  `targets:`, and is **never imported**. Importing one is an error.
- A **`Telo.Library`** is loaded only by an importer. It has no `targets:`,
  reads no environment (an `env:` key in a library is
  `LIBRARY_ENV_KEY_REJECTED`) and is given every value by whoever imports it.

Put behaviour in libraries and keep the application a thin wiring file: the
application imports a feature library, and so does that library's test, so the
test exercises exactly what the application runs without standing up ports or
secrets.

Three words, three things:

- A **starter** is a working manifest copied once into a user's workspace;
  after the copy it is theirs.
- A **blueprint** is a library exporting one templated kind that is a whole
  application; an app imports it and declares one resource of that kind,
  keeping its fixes by bumping the import.
- A **template** means only a definition's body (below) — never a starter or
  a blueprint.

`include:` splits one module's file into partials with no boundary at all —
one scope, no contract. Reach for it when a file is long; reach for a library
the moment something should be reusable, configurable or opaque.

## What to export

`exports:` answers two different questions.

- **`exports.resources` — ready-made instances.** "Here is a configured
  thing; use it." Importers write `!ref <Alias>.<name>` and read
  `resources.<Alias>.<name>.<field>`. Entries are plain names.
- **`exports.kinds` — types the importer instantiates.** "Here is a kind;
  declare your own." Importers write `kind: <Alias>.<Kind>`.

Choose by who should configure the thing:

| Situation | Export |
| --- | --- |
| Importers need several of these, each configured their way | the kind |
| One configured thing everyone uses — a connection, a client, an operation | the instance |
| Importers should not know which backend you chose | the instance |
| Exactly one may exist | the instance, and not the kind |

**One import instead of two.** A library that imports an abstract and its
implementation (`sql` and `sqlite`), configures the connection and exports
the instance leaves its importer one import and no backend choice to make.
That — exporting instances — is the sanctioned way to collapse imports; do not
re-export another module's kinds to the same end.

**Singletons.** Inside the library, your own kinds are `Self.<Kind>` (no
import is involved, and `Self` resolves every kind the library declares,
exported or not). Declare the one
instance as `kind: Self.<Kind>`, export the instance and withhold the kind:
importers can use it but cannot construct another.

```yaml
kind: Telo.Library
metadata:
  name: Greetings
  version: 1.0.0
  description: >-
    Greeting text for one person in a configurable language, ready to call:
    pass a name, get back the sentence to show.
imports:
  Run: oci://ghcr.io/telorun/run@<version>#<pin>
variables:
  greeting:
    type: string
    default: Hello
    description: The word a greeting starts with.
exports:
  resources: [greeter]
---
kind: Run.Value
metadata: { name: greeter }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [name]
    properties:
      name: { type: string }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
value:
  message: !cel "variables.greeting + ', ' + inputs.name + '!'"
```

Both lists also take `<Alias>.<name>` to re-export what an import of yours
owns; every hop resolves to the same instance, never a copy. Without an
`exports` block nothing is gated — always write one.

## Making a kind

A `Telo.Definition` registers a kind. Without writing code there are two ways
to make one, and a third shape for a contract. Pick by intent:

| Your kind is… | Use |
| --- | --- |
| an assembly of several existing kinds | a **templated definition** |
| one existing kind, preconfigured or narrowed | **inheritance**: `extends` + `base:` |
| a contract several implementations will fulfil | a **`Telo.Abstract`** |
| new runtime behaviour nothing exposes | a controller-backed kind in a module of its own |

### Templated composition

The kind declares internal `resources:` and forwards its capability to one of
them with a dispatch verb — `invoke:` (Invocable), `provide:` (Provider),
`run:` (Runnable / Service) or `mount:` (Mount). `inputs:` and `result:` are
top-level siblings: what is passed to the target, and how its answer is
reshaped.

```yaml
kind: Telo.Definition
metadata:
  name: RowCount
  description: >-
    Counts the rows of one database table on demand and returns the number,
    so a dashboard, a health check or a guard can read a table's size
    without writing SQL.
capability: Telo.Invocable
schema:
  type: object
  required: [connection, table]
  additionalProperties: false
  properties:
    connection:
      x-telo-ref: { kind: Sql.Connection, use: dependency }
    table: { type: string, pattern: "^[a-z_][a-z0-9_]*$" }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [count]
    properties:
      count: { type: integer }
resources:
  - kind: Sql.Query
    metadata: { name: query }
    connection: !cel "self.connection"
invoke: !ref query
inputs:
  sql: !cel "'SELECT count(*) AS count FROM ' + self.table"
result:
  count: !cel "int(result.rows[0].count)"
```

- **`self`** is the instance's configuration, typed from `schema:`, in scope
  throughout the body; a field the instance leaves out reads as its schema
  `default:`. `inputs` (the caller's arguments) is in scope in the top-level
  `inputs:` of an Invocable or Runnable; `result` (typed from the target's
  `outputType`) in `result:`.
- **Each `resources:` entry is an ordinary declaration of its own kind.**
  Write it exactly as at the top level; every name that kind binds is in
  scope where it binds it — `inputs` inside a `Run.Sequence`'s steps (its
  own `inputType`, never the template's), `item` in an iteration, `request`
  in an `Http.Api` route, `error` in a `catch:`. A body may hold as many
  entries and dispatches as the work needs.
- **Name every entry with a literal** and name the dispatch target with a
  `!ref` to it (`invoke: !ref query`). Each instance owns its entries in a
  scope of its own, so literal names never collide; a name computed from
  `self` is `TEMPLATE_ENTRY_NAME_DYNAMIC`, a bare string or `{ kind, name }`
  at a dispatch slot `INVALID_REFERENCE_FORM`, and a `!ref` naming no entry
  `TEMPLATE_DISPATCH_UNKNOWN`. A reference inside an entry names a sibling
  entry or a resource of the declaring module.
- **A consumer's list or map becomes many entries with `!for-each`** (`in:` a
  bare `self.<path>` the consumer writes literally; `each.value` / `each.key` /
  `each.index` in `emit:`), and `!if` / `!switch` choose a value, an item or an
  entry's kind from what the consumer wrote. A `!for-each` at a `resources:`
  entry is a family — the tag carries `metadata: { name: crons }`, `emit:` is one
  unnamed declaration — and `targets: [!for-each { in: !cel "self.jobs", emit:
  !ref crons[each.key] }]` starts its members. A computed source is
  `REPEAT_COMPUTED`. A module whose own manifest writes these tags declares
  `requires: telo:` at the release that carries them.
- **A reference the instance holds reaches an entry only through a bare
  `!cel "self.<path>"`** — one slot (`connection: !cel "self.connection"`) or
  a whole value holding several (`routes: !cel "self.routes"`). Never build
  such a value with an expression (`self.items.map(…)`): CEL values are data,
  the reference is lost, and it is `REF_SLOT_COMPUTED`. Declare the field on
  your kind already shaped as the entry expects and forward it whole. A bare
  path may continue past one of your reference slots into the resource it
  names (`!cel "self.model.schemas.list"`).
- **A forwarded value is checked as the entry's own field**, against the
  entry kind's schema, reference slots and CEL contexts, and reported on the
  importer's own line. So your `schema:` declares only what your kind adds —
  titles, required fields — and does not restate the entry's constraints or
  context blocks; it keeps every **reference slot** (`x-telo-ref`) beneath a
  forwarded value, which is what lets the reference resolve where the
  importer wrote it. A contradiction is `TEMPLATE_FORWARD_INCOMPATIBLE`.
- **Starting several things.** A Service or Runnable kind that starts more
  than one entry — a server and the poller beside it, a migration before the
  server — lists them in `targets: [!ref migrate, !ref server]`, started in
  order, instead of `run:`. Never both, and never on an Invocable, Provider
  or Mount kind.
- `provide:` reads its target — invoked (with `inputs:` when written) or, for
  a provider target, read through its own `provide()`; a provider target
  takes no `inputs:`.

A blueprint is this shape scaled up: a Service kind whose body is a whole
application — a server, its routes, a store — configured from `self`.

### Inheritance — one kind, specialized

`extends:` any kind, concrete or abstract (alias-qualified, `Self.<Kind>` for
your own), and omit `controllers:`. The child runs the parent's controller,
has its capability (omit `capability`, or restate it identically — a
different one is `EXTENDS_CAPABILITY_MISMATCH`), and **is** a parent instance:
it fits every reference slot the parent fits, transitively.

```yaml
kind: Telo.Definition
metadata:
  name: GithubClient
  description: >-
    An HTTP client preconfigured for the GitHub REST API from a personal
    access token, usable anywhere an HTTP client is accepted.
extends: Http.Client
schema:
  type: object
  required: [token]
  additionalProperties: false
  properties:
    token: { type: string }
base:
  baseUrl: https://api.github.com
  headers:
    Authorization: !cel "'Bearer ' + self.token"
    Accept: application/vnd.github+json
---
kind: Telo.Definition
metadata:
  name: SearchRepos
  description: >-
    Searches GitHub repositories with a query string and returns the API's
    answer, through any GitHub client.
extends: Http.Request
schema:
  type: object
  required: [client, q]
  properties:
    client:
      x-telo-ref: { kind: Http.Client, use: dependency }
    q: { type: string }
base:
  client: !cel "self.client"
  inputs:
    url: /search/repositories
    method: GET
    query:
      q: !cel "self.q"
```

- **With `base:`** — the "super(…)" mapping — the child's own `schema:` is
  the whole author surface, and `base:` builds the parent's configuration
  from `self` once, at creation. Those own fields are construction inputs:
  evaluated at creation without any annotation, never published, and unable
  to read observed state (`resources.x.status…`), since nothing has run.
- **Without `base:`** the child is a pure extension: its surface is the
  parent's schema merged with its own, the whole configuration goes to the
  parent, and the fields it adds are published beside the parent's reading.
  A parent with a closed schema cannot take an added field
  (`EXTENDS_CLOSED_PARENT_ADDS_FIELD`) — use `base:`.
- **Forward a reference bare**: `client: !cel "self.client"`, nothing more.
  Any wrapping of it fails, so keep reference forwarding and value-building
  expressions in separate `base:` fields.
- **Never `base:` beside a body** (`resources:`, `controllers:`, a dispatch
  verb): `BASE_WITH_TEMPLATE_BODY`. A kind is either a template or a
  specialization.
- **A signature of your own.** `inputType` / `outputType` resolve to the
  nearest declaration along `extends` and replace — never merge. A child that
  declares its own contract also declares the mapping back: `inputs:` (its
  inputs → the parent's) for an `inputType`, `result:` (the parent's result →
  its own) for an `outputType`, or `telo check` reports
  `CONTRACT_MISSING_MAPPING`.

### Abstract contracts

A `Telo.Abstract` is a kind with no implementation: a contract that several
kinds fulfil by `extends`, so a consumer types its slot against the contract
and the application chooses the implementation. It declares a capability, the
invocation contract and — optionally — the errors every implementation may
raise:

```yaml
kind: Telo.Abstract
metadata:
  name: Notifier
  description: >-
    Delivers one short text message to one recipient and returns the id the
    channel assigned. A refused recipient and an unavailable channel are
    distinct errors, so a caller can retry only what may succeed later.
capability: Telo.Invocable
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [to, text]
    additionalProperties: false
    properties:
      to: { type: string }
      text: { type: string, maxLength: 1000 }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [id]
    properties:
      id: { type: string }
throws:
  codes:
    ERR_NOTIFY_REJECTED:
      description: The channel refused the recipient or the message.
    ERR_NOTIFY_UNAVAILABLE:
      description: The channel could not be reached. Retrying later may succeed.
```

- An implementation `extends: <Alias>.Notifier` (`Self.Notifier` in the same
  library) and is a templated kind, a specialization of a concrete kind, or a
  controller-backed kind in another module. The contract never names its
  implementations.
- The `throws.codes` list is a **ceiling**: a descendant that declares a
  `throws:` list of its own may name only codes within it
  (`THROWS_NOT_SUBSTITUTABLE`), so a caller's `catches:` / `try:` written
  against the contract stays complete for any backend. Raise failures under
  the contract's codes.
- Give a code the words a person is shown with `displayMessage:` beside its
  `description:` — a text in the library's `lang:` whose placeholders name
  only REQUIRED string or number properties of the code's `data` schema
  (`displayMessage: "The channel refused {$to}."` with `data: { type: object,
  required: [to], properties: { to: { type: string } } }`). Every failure
  under that code leaving the kind carries it as `error.displayMessage`, and
  data the schema refuses is refused instead, so it always formats.
- A kind that renders failures through a catch list (`x-telo-outcome-list:
  catches`) marks, in that list's `x-telo-context`, which members carry the
  caught code and data: `code: { type: string, x-telo-caught-member: code }`
  and `data: { type: object, x-telo-caught-member: data }`, under whatever
  bindings it offers. A `when:` comparing a marked code chain with code
  literals proves coverage, and every marked data member is typed inside each
  entry from the codes it matches; a list marking no code proves nothing.
- Use an abstract only where there will be more than one implementation, or
  the backend is the importer's choice. To reuse one controller under a
  friendlier schema, specialize the concrete kind instead.

## The importer contract

A library's inputs are its public contract. State each one with a `type`, a
`description`, and a `default` only where one is genuinely right for every
importer.

- **`variables` / `secrets`** — JSON Schema entries, no `env:`. A credential
  is a `secret`; a base URL, a limit or a name is a `variable`. Anything an
  importer would want to point elsewhere (a vendor's base URL, a token) is an
  input from the start — a URL written into a request cannot be tested. What an
  importer supplies is checked against the entry at the import, statically and when
  it initializes, so declare each entry's real type (`type: integer`,
  `x-telo-type: Telo.Url`); text in a value type's encoding is decoded first.
- **`resources`** — instances the library **borrows** from its importer,
  constrained by kind only:

  ```yaml
  kind: Telo.Library
  metadata: { name: Orders, version: 1.0.0, description: … }
  imports:
    Sql: oci://ghcr.io/telorun/sql@<version>#<pin>
  resources:
    connection:
      kind: Sql.Connection
      description: The database orders are written to.
  ```

  Inside, `!ref connection` and `resources.connection.<field>` work as for a
  local resource. The importer supplies `resources: { connection: !ref db }`
  at its import. The library never tears a borrowed instance down, and an
  input cannot also be exported. Use this whenever two libraries must share
  one instance: two libraries that each import a third get two of everything
  in it — two connections where one was meant, and a writer and a reader that
  never see each other's work.
  Mark an entry `optional: true` when the library can offer a default of its
  own: `resources.<input>` is then nullable, the default is a declaration-position
  `!if` on `resources.<input> == null`, and `!ref <input>` is legal only in a branch
  proving it present. A member that must be registered with a collector (a
  schema's tables, a server's mounts) is never such a default: only the
  collector's own module lists its members.
- **`needs`** — what the library depends on but cannot create (a database's
  address and credentials, a signing key), each entry naming a **need type**:
  `needs: { databaseAccess: { kind: Fx.DatabaseAccess, version?, features?, optional?, parameters? } }` — a stated `version` / `features` must reach a reference slot that `observes` it (`NEED_CONSTRAINT_UNVERIFIED`).
  Prefer a need over `variables` / `secrets` for such a dependency: it is
  typed, an importer that does not use it writes nothing, and a sensitive
  field is redacted wherever it reaches. Inside, read it by field —
  `resources.databaseAccess.url` — or hand it whole to a kind's reference slot
  that takes its need type (`!ref databaseAccess`). The
  importer supplies it whole (`needs: { databaseAccess: !ref <its own need or
  fulfilment> }`) or field by field (`needs: { databaseAccess: { url: … } }`);
  one nobody supplies bubbles up to the application, which reads it from the environment at load (`TELO_NEED_<PATH>__<FIELD>`, or the name an application need's `env:` binds); a required one with none set is
  `ERR_NEED_UNMET`. A need type is a `Telo.NeedType` document (`fields`,
  `required`, `parameters`) exported through `exports.kinds`, named for what
  its fulfilment hands over — `<Thing>Access` for the address and credentials
  of something outside the application. A library that serves HTTP and needs
  to know an address it is reached at (to build absolute links, or to route by
  host with a mount's `hostnames`) declares `Telo.PublicUrl` /
  `Telo.PublicHostPattern` with no parameters; the application declares its
  own, naming a port, and forwards it whole — anything else is
  `NEED_ROOT_SUPPLY_REQUIRED`. A library that keeps files across restarts
  declares a `Telo.DurableDirectory` need (`size`, `access`) and reads it as
  `resources.<need>.path` — never a data directory as a variable; one
  directory forwarded to two needs is `NEED_DIRECTORY_FORWARDED_TWICE`. Never name a router like a need: they share one
  namespace.
- **`lifecycle`** — `isolated` (the default) gives every import declaration
  its own instantiation: right for a library whose instances are the
  importer's (a client, a formatter, a test fixture). `shared` gives the whole
  application one instantiation that every import, at any depth, resolves to:
  right for a library that **owns** something several others need. Every
  import of a shared library must then agree on its configuration and its
  needs (`SHARED_LIBRARY_CONFLICT`).

## Names, descriptions and metadata

- **Case encodes what a name denotes.** `PascalCase` for types — the
  library's `metadata.name` (it becomes the kind prefix, and holds no dot),
  kinds, import aliases, `Telo.JsonSchema` shapes. `camelCase` for values —
  resource instances, steps, `variables` / `secrets` / `resources` keys.
  A name matches `^[A-Za-z_][A-Za-z0-9_]*$` and is no CEL keyword: no hyphen,
  no dot. The `env:` an application binds is `SCREAMING_SNAKE_CASE`;
  directories and published repository names are `kebab-case`.
- **`metadata.description` is search text** on the library and on every kind:
  it is what a reader who does not yet know your library exists matches
  against. One paragraph of 40–60 words, leading with what it does in the
  words a searcher would type. No kind or capability names, no backend names
  in a generic library, no comparison with siblings, nothing that only makes
  sense against history. A kind's description states its operation, inputs,
  outputs and what a failure means. Rationale goes in comments and docs.
- **`metadata.categories`** is a short list of display labels (`[Data,
  Storage]`) — a grouping facet, never repeated in the description. Reuse an
  existing label: `AI`, `Compute`, `Configuration`, `Coordination`, `Data`,
  `Observability`, `Performance`, `Reliability`, `Scheduling`, `Storage`,
  `Streaming`, `Testing`, `Transport`, `Visualization`.
- **`metadata.license`** names the license of the library's own files (an
  SPDX identifier) and the license file ships beside `telo.yaml`.

## Declaring the runtime it needs — `requires:`

A library declares the oldest Telo it is verified against, open above:

```yaml
requires:
  telo: ">=<oldest verified release>"
```

Bounds use explicit comparators; `^`, `~`, a bare version, `||`, hyphen
ranges and wildcards are refused (`REQUIRES_INVALID`). Raise the floor in the
same change that adopts syntax an older release cannot read — a new
annotation, a new key on a built-in document, a new shape of an existing
field — so an older runtime reports one `MODULE_REQUIRES_NEWER_RUNTIME`
instead of blaming your file with a schema error. Verify it by running the
older release's `telo check` against the library: it must reject the file
without the floor and report the floor with it. A field your kinds merely
offer to importers needs no floor of yours; the importer who writes the new
syntax declares it.

## Inline or named

Declare a resource **inline at its use site** when it is used exactly once
(`invoke: { kind: Sql.Query, connection: !ref db }`), with no
`metadata.name`. Give it a top-level document of its own only when something
must name it: it is referenced more than once, listed in `targets:`, or
exported. A router mounted on a server stays named, so it can be tested on
its own. In a template body, entries are always named (the dispatch verb
names one). An inline declaration holds the kind's own fields, a `name` among
them when the kind declares one (`icon: { kind: UiLucide.Icon, name: house }`);
for a kind declaring no `name` field, `{ kind, name }` is the removed form of a
reference (`INVALID_REFERENCE_FORM`) — write `!ref <name>`.

## Testing a library

A library's tests live in its own `tests/` directory and **import the library
by relative path** — `Orders: ../` — so they see exactly the exports, inputs
and errors an importer sees:

```yaml
kind: Telo.Application
metadata: { name: PlacesAnOrder, version: 1.0.0 }
imports:
  Orders:
    source: ../
    resources: { connection: !ref db }
  Sql: oci://ghcr.io/telorun/sql@<version>#<pin>
  SQLite: oci://ghcr.io/telorun/sqlite@<version>#<pin>
  Run: oci://ghcr.io/telorun/run@<version>#<pin>
  Assert: oci://ghcr.io/telorun/assert@<version>#<pin>
targets:
  - !ref placesAnOrder
---
kind: SQLite.Connection
metadata: { name: db }
file: ":memory:"
---
kind: Run.Sequence
metadata: { name: placesAnOrder }
steps:
  - name: schema
    invoke: { kind: Sql.Command, connection: !ref db }
    inputs: { sql: "CREATE TABLE orders (id text PRIMARY KEY, sku text NOT NULL)" }
  - name: place
    invoke: !ref Orders.placeOrder
    inputs: { id: o-1, sku: ABC }
  - name: assert
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.place.result"
      expected: { id: o-1 }
```

- One file per behaviour, named after it, plus a suite (`tests/telo.yaml`, a
  `Test.Suite` with `include: ["*.yaml"]` and `exclude: ["telo.yaml",
  "**/__fixtures__/**"]`). Fixtures go under `tests/__fixtures__/`.
- Supply `variables`, `secrets` and `resources` at the import, as an
  importer would — a dummy secret, a local database, a mock server's URL.
  Never call a real third-party service: stand an `Http.Server` with canned
  routes in the test's `with:` scope and point the library's base-URL
  variable at it.
- Test an exported kind by declaring an instance of it in the test (`kind:
  <Alias>.<Kind>`); test an exported instance by invoking it.
- Pin each refusal the library owns — a resource rule, a malformed input —
  with a fixture manifest under `tests/__fixtures__/` that writes the mistake,
  run by `Assert.Manifest` expecting its diagnostic code (and `runFails` for
  what the kernel refuses at boot).
- A test that needs a real database or queue starts it as a container; see
  the `write_integration_tests` guide.
