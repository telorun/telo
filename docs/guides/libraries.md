---
description: "Share and reuse manifests: writing a Telo.Library, importing it by relative path or as a published module, choosing what it exports, and splitting a file with include."
---

# Libraries

The unit of reuse in Telo is the **library**. A `Telo.Library` is an importable
manifest with its own scope, its own configuration contract, and an explicit
list of what it lets importers see — the same shape whether it lives in a
sibling directory or is published for the world.

A note on vocabulary, because Telo uses two words. **Library** is the kind you
write (`kind: Telo.Library`). **Module** is the unit it becomes once published —
what `telo module versions` inspects and what the [hub](https://hub.telo.run)
indexes. They are not synonyms: an Application is a module too, with its own
scope, but it is never a library because nothing can import it.

This page is about libraries: writing one, importing one, choosing what it
exports, and publishing it when it outgrows your repo. It ends with `include:`,
which splits a file without creating a boundary at all.

## A library, and importing it

A library's resources are invisible to the importer unless explicitly exported.
Start one anywhere in your repo — no publishing, no registry, no build step:

```yaml
# libs/greetings/telo.yaml
kind: Telo.Library
metadata:
  name: Greetings
  version: 1.0.0
  description: Greeting text for one person, in a configurable language.
imports:
  Run: oci://ghcr.io/telorun/run@<version>
variables:
  greeting:
    type: string
    default: Hello
exports:
  resources:
    - Greeter
---
kind: Run.Value
metadata:
  name: Greeter
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      name: { type: string }
    required: [name]
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      message: { type: string }
    required: [message]
value:
  message: !cel "variables.greeting + ', ' + inputs.name + '!'"
```

Note the library declares `variables:` **without an `env:` key**. Only the root
application reads the host environment; a library is given its values by
whoever imports it (an `env:` inside a library is rejected outright with
`LIBRARY_ENV_KEY_REJECTED`).

The importer supplies them and reaches the export by alias:

```yaml
kind: Telo.Application
metadata:
  name: GreetingApp
  version: 1.0.0
imports:
  Console: oci://ghcr.io/telorun/console@<version>
  Run: oci://ghcr.io/telorun/run@<version>
  Greetings:
    source: ./libs/greetings
    variables:
      greeting: Hej
targets:
  - !ref Main
---
kind: Run.Sequence
metadata:
  name: Main
steps:
  - name: Greet
    invoke: !ref Greetings.Greeter    # <Alias>.<exported name>
    inputs:
      name: World
  - name: Print
    inputs:
      output: !cel "steps.Greet.result.message"
    invoke: !ref Console.writeLine
```

```
Hej, World!
```

An import entry is either a bare source string (`Console: oci://…`) or the
object form above when you need to pass `variables:` / `secrets:`. Either way
the alias is yours to choose: it is the prefix on every kind and every
cross-module reference in the importing file, so the library never dictates what
you call it.

`source: ./libs/greetings` is a **relative path** — the library is read from
disk. That is the whole setup. Nothing about the library changes when it later
becomes a published module; only the importer's `source:` does.

## Two things a library can export

`exports:` has two lists, and they answer different questions.

### `exports.resources` — ready-made instances

"Here is a configured thing; use it." The consumer references it as
`!ref <Alias>.<name>` and reads its published values as
`!cel "resources.<Alias>.<name>.<field>"`. Entries are plain name strings — the
`!ref` tag is not used in the export list itself.

This is the tool for hiding wiring. A library that imports `sql` **and**
`sql-sqlite`, configures a connection, and exports just that instance leaves its
consumer with **one** import instead of two:

```yaml
exports:
  resources:
    - Db          # a configured Sql.Connection, ready to use
```

### `exports.kinds` — types the importer may instantiate

"Here is a blueprint; make your own." The consumer writes
`kind: <Alias>.<Kind>` and configures it themselves.

```yaml
exports:
  kinds:
    - Greeter
```

Export a kind, an instance, or both. Omitting the kind while exporting an
instance is how you enforce a singleton — consumers can use your configured
resource but cannot construct another.

Inside the library, refer to your own kinds through the automatic **`Self`**
alias (`kind: Self.Greeter`) — there is no import to alias against, and `Self`
resolves your own kinds regardless of what you export.

### Re-exporting

Both lists accept `<Alias>.<name>` to pass something through from a library you
yourself import:

```yaml
exports:
  resources:
    - Domain.Db          # re-export the instance my `Domain` import owns
  kinds:
    - Domain.Repository
```

Re-export is transitive to any depth, and every hop resolves to the **same
instance** — not a copy.

## Which one do I want?

| Situation | Use |
| --- | --- |
| A reusable piece with its own configuration | a `Telo.Library` in-repo, imported by relative path |
| Consumers should not have to know which backend you chose | a library exporting the configured **instance** |
| Consumers need to declare many of these themselves | a library exporting the **kind** |
| Other teams or repositories need it | publish the library — [Authoring a module](/extend/authoring-a-module) |
| One app, one scope, files just getting long | `include:` — see below |

## Publishing

A library imported by relative path becomes a published module with no
structural change — you pin it by ref instead of path:

```yaml
imports:
  Greetings: oci://ghcr.io/acme/greetings@1.2.0
```

`metadata.description` on the library and on each kind is what the
[hub](https://hub.telo.run) indexes for search, so write it for someone who does
not yet know your module exists. See [Authoring a module](/extend/authoring-a-module)
and, for extending an existing kind rather than composing one,
[Kind inheritance](/extend/kind-inheritance).

## When you do not want a boundary — `include:`

Sometimes a file is simply long, and there is nothing to encapsulate. `include:`
loads other files into the **same module scope**, as if you had pasted them in:

```yaml
kind: Telo.Application
metadata:
  name: MyApp
  version: 1.0.0
include:
  - ./routes/*.yaml
  - ./handlers/*.yaml
```

The included files are *partials*: resource documents only, and they may not
declare `Telo.Application`, `Telo.Library`, or `Telo.Definition`. Everything
lands in one scope, so a `!ref` in one file resolves a resource declared in
another with no ceremony, and the including file's `imports:` aliases are the
ones a partial's kinds are written against.

**This is not a library.** There is no separate scope, no configuration
contract, and nothing hidden — the split is for readability, and every name
stays global to the module. Reach for it when one application's file has grown
unwieldy; reach for a library the moment something should be reusable,
configurable, or opaque from the outside.

One use worth knowing: a partial can be included by an application **and** by
its test, so the test exercises the same declarations the app serves rather than
a copy that can drift.

## See also

- [Module system](/reference/kernel/modules) — the normative rules for scope,
  refs, and transports.
- [Configuring an application](/learn/configuration) — the configuration
  boundary this page relies on.
