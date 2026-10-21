# Outline conformance vectors

What an analyzer answers when asked what a module does — the `outlineVersion: 1` document `telo describe -o json` prints — frozen as data: every analyzer that builds an outline reads these vectors and produces each expected document exactly.

## Format

`vectors/<name>/` is one vector:

- `telo.yaml` — the entry module, a `Telo.Application` or a `Telo.Library`. Every module it imports sits beside it, under the vector's own directory, imported by relative path; nothing is fetched.
- `outline.json` — the outline of that module: the analysis's facet over its module graph, with the entry module doc as the graph's root and its name as the entry module.

A vector analyzes clean: no load error and no error diagnostic. Ids are the module graph's — `<module>\u0000<kind>\u0000<name>` for a resource, `#step:` / `#entry:` / `#target:` rows beneath it — so a runner compares the document as JSON, ids included.

Every value the document carries as written — a matcher's in `match`, a call's `inputs`, a step's `predicate`, a boot target's `when`, an input's `default` — is in one encoding, so a literal can never read as an expression:

- a JSON scalar or array is itself;
- a tagged value is `{ "tag", "source", "type"? }`: the YAML tag without its `!` (`cel`, `interpolate`, `ref`), the text written after it, and the static type where the analyzer has one other than `dyn`. A reference is decided by the kind's reference sites, never by a value's `{kind, name}` shape, and its `source` is the `!ref` text;
- a literal mapping is `{ "map": { … } }`, at every depth — so the literal `{ tag: cel, source: "1+1" }` is `{ "map": { "tag": "cel", "source": "1+1" } }`, while `!cel "1+1"` is `{ "tag": "cel", "source": "1+1", "type": "int" }`.

`match` itself is a map from each matcher field to its value. An object a matcher holds is read for its leaves to two levels and flattened into that map, so its keys are matcher fields; an object element of a matcher list is the mapping of its leaves. An expression in `match` carries its `type` like any other value. The module graph's own `match`, which row ids derive from, carries none, so an id never moves when an expression's type changes.

Three fields the document carries beyond the module graph's own words:

- `roots` — the module-graph node ids the walk over `resources` starts from, in order: an Application's boot targets in `targets:` order, then every service a control edge starts; a Library's exported instances. Every entry of `resources` is reached from one of them.
- `class` — on an edge, what happens at its site, as the module graph classes it: `flow` (control transfers — `call`, `detached`, `trigger.inbound`, `trigger.consumer`), `holds` (`dependency`), `shape` (`schema`), `data` (a CEL read of another resource's published state).
- `predicateField` — on a step row, the field whose expression decides whether or how the step runs, as the step grammar annotates it (`if`, `while`, `switch`, a dispatch's `when`); `predicate` is the expression written at `<row path>.<predicateField>`. A boot target's guard is its `when`.

## Vectors

- `application` — inputs bound to the environment and the command line, a secret with a default it never shows, an Application need, a gated inline boot target, a step body with both branches of an `if`, entry points labelled by an entry list's matcher and by a top-level matcher of a kind the module declares itself, a catch ladder answering per code across a route's list and its server's scope list (undecided entries, an unbounded union's one answer for any other code), and an unreached resource.
- `library` — a Library's variables, secrets and resource input, its own need and an imported library's need reaching it unsupplied (fields with no environment name), and its exported instance as the root.
- `router-on-two-servers` — one router mounted on two servers, one rendering a code with a `when:` naming it, the other with a catch-all: coverage is per code, so the code is `covered` and each server's rung names its own entry.
- `written-values` — the literal mapping `{ tag: cel, source: "1+1" }` beside `!cel "1+1"` in a step's `inputs`, the same literal as an element of a matcher list and as a variable's default, a `!ref` at a reference slot inside a call's `inputs`, and typed expression matchers: an `!interpolate` matcher of an entry list and a top-level `!cel` matcher of a kind the module declares.

## Runners

- `analyzer/nodejs/tests/outline-conformance.test.ts` — `ManifestAnalysis.outline`.

`analyzer/rust` builds no outline yet; it owes a runner.
