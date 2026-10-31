---
description: "One application on several backends: choose resources, fields and start-up targets with !if and !switch from the application's inputs, see how every combination is checked, and ask only for the inputs the chosen setup uses."
---

# Choosing by configuration

An application often has more than one way to run: Postgres when a database URL
is supplied and SQLite otherwise, OpenAI when one key is set and Anthropic when
the other is, an admin server only in some deployments. Writing that as one
manifest per setup duplicates everything the setups share; writing it as code
hides it from `telo check`. Telo lets the manifest choose.

`!if` and `!switch` pick a branch from the application's own **inputs**. Every
combination of the inputs a choice reads is a **configuration**, `telo check`
checks all of them, and the kernel starts the one the environment selects —
creating only its resources and loading only its controllers.

## Choosing

```yaml
kind: Telo.Application
metadata: { name: Notes }
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
needs:
  databaseAccess:
    kind: Postgres.DatabaseAccess
    optional: true
variables:
  dataFile:
    env: DATA_FILE
    type: string
    x-telo-type: { name: Telo.HostPath, entry: file }
    default: /var/lib/notes/notes.db
--- !if
metadata: { name: db }
if: !cel "resources.databaseAccess != null"
then:
  kind: Postgres.Connection
  access: !ref databaseAccess
else:
  kind: SQLite.Connection
  file: !cel "variables.dataFile"
```

With `TELO_NEED_DATABASE_ACCESS__URL` set the application runs on Postgres;
without it, on a SQLite file. **A backend is chosen by the environment through
the presence of its own input**: nothing says "use Postgres" — supplying what
Postgres needs does. Everything else in the application refers to `db` and
neither knows nor cares which kind stands behind the name.

A choice can stand where a value, a list item or a whole declaration goes:

- **A field's value** — `dialect: !if { if: …, then: a, else: b }`, or `!switch`
  with `switch:` and `cases:` (and `default:`).
- **A list item** — a `targets:` entry, a `with:` member, a step. The chosen
  branch is the one item, or nothing.
- **A whole resource document or `with:` scope member** — written as above, with
  the `metadata` on the tag and one unnamed declaration per branch. The name is
  the same in every configuration, only the kind behind it varies, so renames,
  `exports.resources` and `!ref db` read one place. A reference to a declaration
  that exists in only some configurations is an unresolved reference where it
  does not. A library may re-export such a declaration (`exports.resources:
  [Inner.db]`): it is the instance the inner import's binding chose, and an
  open inner binding is refused at that binding.

`if:` yields a boolean. `switch:` yields a string, an integer or a boolean, each
case key is a value of that type (`1`, never `01`), and the cases must cover the
selector's domain or end in `default:`. Branches nest, in either order with
`!for-each`. Inside a template, a choice may also pick the kind behind a named
entry; see [Templated definitions](/extend/templated-definitions).

Imports are not chosen: an application imports every backend it may run on, and
only the chosen branch's controller loads. A variable's `default:`, an `include:`
and a kind's schema are not choosable either (`BRANCH_POSITION_INVALID`); an
import's `variables:` value is chosen with a `!cel` ternary.

## What a choice may read

A choice is decided before anything runs, so it may read only what is known
then. There are three **projections** of an application input, each with a
closed domain — these are the **dimensions**:

| Projection | Written | Domain |
|---|---|---|
| The whole value of a `variables:` entry declared `enum`, `const` or `type: boolean` | `variables.dialect` | the listed values |
| A member a value type's argument closes | `secrets.databaseUrl.scheme`, where the entry is `x-telo-type: { name: Telo.Url, scheme: { enum: [postgres, sqlite] } }` | the listed values |
| Presence | `secrets.openaiApiKey != null`, `resources.databaseAccess != null` | `present`, `absent` |

A dimension is keyed by the path it is read at — `variables.dialect`,
`secrets.databaseUrl.scheme`, `resources.databaseAccess` — and that key is what
`telo check`, the editor and `telo needs report` use.

Anything else is `BRANCH_UNDECIDABLE`: another member of the URL (`.host`), an
open string variable, a `ports` read, a request, a step result,
a resource's published state. A bounded integer is not a dimension (`minimum` /
`maximum` say which values are valid, not which behave differently): declare an
`enum` of the values that differ. A list of flags is one boolean variable per
flag.

**Crossings.** A condition inside a template may read through a `!ref` into the
declaration it names (`self.table.mode`), as that declaration was written with
its kind's defaults filled — never what it publishes at run time — provided the
declaration is in the consumer's own module. Crossing into another module's
declaration is `BRANCH_UNDECIDABLE`, because it would tie the consumer's
configurations to something a library may change in a patch release. A
condition may also call a module function written in CEL, whose arguments are
read as the condition's own.

## Absence

A choice with nothing to choose contributes **nothing to its container**: an
`!if` with no `else:` and a false condition leaves no list item, no field, no
map entry and no declaration.

```yaml
secrets:
  licenseKey: !if
    if: !cel "secrets.licenseKey != null"
    then: !cel "secrets.licenseKey"
```

A `variables:` / `secrets:` entry that may be absent declares `default: null`,
whatever its `type:`. With nothing supplied it is `null` — never validated and
never asked for — and a parent or importer may supply `null` for it. Its CEL
type is then nullable, so an unguarded read is `CEL_NULLABLE_ACCESS`. A `ports:`
entry never admits absence: every declared port is assigned wherever the
application runs. A schema `required` key left absent by a choice is a
`SCHEMA_VIOLATION` in the configurations where it is absent.

A library admits an absent resource the same way: a `resources:` entry marked
`optional: true` (see [Sharing across libraries](/extend/library-resource-inputs)).

## Narrowing

Inside the branch that proves an input present, it is not null — no guard is
needed to read it, and a `!ref` to an optional need is legal. Inside a branch
where a scheme dimension is `postgres`, the member is that literal:

```yaml
value: !if
  if: !cel "variables.config != null"
  then: !cel "variables.config.host"
  else: none
```

A whole-value chain from a dimension to a slot (`dialect: !cel "variables.dialect"`)
is held to the slot as that configuration's literal. A slot accepting
`[postgres, sqlite]` fed by a variable that also allows `mysql` is a
`SCHEMA_VIOLATION` in the `mysql` configuration alone, and the message says so.

## Every configuration is checked

The set of configurations is the product of the dimensions' domains: a
`dialect` of `[sqlite, postgres]` and an `openaiApiKey` present or absent are
four. `telo check` expands the application once per configuration and runs every
check over the whole of it — references, init order, the call graph, zones,
throws coverage, rules, exports — and there is no cap, because a cap would leave
a path unchecked. A declaration's own checks run once per distinct combination of
what it reads, so one no choice reaches is checked once however many
configurations exist.

A finding that holds in every configuration prints as is. One that holds in only
some ends with the smallest description of them:

```
error  … SCHEMA_VIOLATION (when variables.dialect is mysql)
error  … CEL_NULLABLE_ACCESS (when secrets.openaiApiKey is absent)
```

A finding is reported where its value is written: a schema message about a list
item a choice includes, or one after it, quotes the written index and branch
(`/targets/1/then/timeout`), the same in every configuration, never the position
that configuration's expansion gave it. So does a reference, step `invoke:`
or match message that names a place (`reference at 'targets[1].then'`).

`telo check -o json` and the editor carry the same as `data.configurations` — a
list of `{ "<dimension>": value }` assignments. A finding inside a branch no
configuration takes says so. The studio's module graph draws one configuration at
a time, starting from each dimension's `default:`, and lets you pick another.

A case no configuration selects is `BRANCH_CASE_UNREACHABLE` (a warning; it is
still checked), and a `!switch` that misses a value in some configuration is
`BRANCH_NOT_EXHAUSTIVE`.

## Asked only for what the setup uses

Without choices, an input with no `default:` is required whether or not anything
reads it, so an application using either of two AI providers demands both API
keys. With them, an application `variables:` / `secrets:` / `ports:` entry with
no `default:` is **required in exactly the configurations a manifest read
reaches it**, and a need that is not optional in exactly those where its fields,
its `!ref`s or an import forwarding it reach it — a library's need translated
through every import between it and the application. A dimension is always
required unless it has a `default:`, since it decides which configuration starts.

```yaml
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string, default: null }
  anthropicApiKey: { env: ANTHROPIC_API_KEY, type: string }
--- !if
metadata: { name: model }
if: !cel "secrets.openaiApiKey != null"
then:
  kind: OpenAI.Model
  apiKey: !cel "secrets.openaiApiKey"
else:
  kind: Anthropic.Model
  apiKey: !cel "secrets.anthropicApiKey"
```

This boots with `OPENAI_API_KEY` set, or with `ANTHROPIC_API_KEY` set alone, and
refuses with neither — naming only `ANTHROPIC_API_KEY`. The same derivation shows
up wherever inputs are listed:

- `telo run <app> --help` marks each input `required`, `required when
  OPENAI_API_KEY is unset`, or nothing, and `telo needs report` and `telo env
  template` print the same sentence.
- `telo needs report` and `telo module manifest --json` give each input and need
  a `requiredWhen` — the assignments that need it, keyed by dimension — with the
  `dimensions` those keys name (`{ key, values, env, member? }`, `member`
  naming the member a dimension reads, such as a URL's `scheme`).
- At a terminal `telo run` asks for what the starting configuration requires and
  nothing else; `--no-input` and every runner refuse, naming those inputs.

An input the configuration does not require is neither asked for nor refused
when missing, but a value supplied anyway is still read and validated.

**Ports under a runner.** A runner assigns and exposes every declared `ports:`
entry in every configuration, so a port's requiredness governs only `telo run`'s
own validation: a port no configuration of this start reads is not demanded.
`requiredWhen` is reported for ports, but runners do not use it to decide which
to assign. For that reason a port cannot be optional — keep a `default:` on it
and choose the optional server with a boolean variable (`ADMIN_ENABLED`).

## Starting

The kernel resolves every dimension first, by the usual precedence (name,
argument, environment, `default:`), and validates each against its schema. A
value outside its domain — an enum value not listed, a URL whose scheme is not
allowed — is refused before any resource exists, naming the input and its allowed
values; it is the one refusal analysis cannot make, since no check sees your
environment. The presence of each optional need is read from the environment at
the same moment. Only then are the application's documents expanded, and the
inputs the chosen configuration requires resolved. `Kernel.Starting` carries
the chosen values as `configuration`, keyed like the dimensions.

A dimension is fixed for the life of the process: changing one means a restart,
and a reload reconciles over the running configuration's documents.

A choice or expansion refusal a library's own `telo check` makes is raised when
an import loads it, as `ERR_MANIFEST_VALIDATION_FAILED` carrying each finding
under its own code, so a library whose own check was never run cannot reach
boot unrefused.

## See also

- [Configuring an application](/learn/configuration) — declaring variables, secrets and ports.
- [Declaring a need](/learn/declaring-a-need) — choosing by whether a need is supplied.
- [Providing needs](/learn/providing-needs) — the needs report, `dimensions` and `requiredWhen`.
- [Templated definitions](/extend/templated-definitions) — choices and repeats inside a template body.
