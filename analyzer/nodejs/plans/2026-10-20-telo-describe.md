# Plan — `telo describe`: what an application does, read from its manifest

## Problem

Nothing tells a reader what an application does without reading every document of it. Which
environment variables it reads and what each one feeds, what it starts at boot, which requests,
schedules and streams it reacts to, and what each of those does in turn are all facts the analyzer
already holds — the call graph, the module graph, the application contract, the need table, the
CEL read chains, the throws unions and the catch coverage — but no surface joins them. A packaged
application is worse off: every argument belongs to the application, so its operator has no way to
reach the CLI at all beyond `TELO_APP_INFO=1`, which prints the payload index and nothing else, and
no way to run it with `--inspect` or `--debug`.

## After the change

### The outline is a facet of the analysis

`ManifestAnalysis.outline` is a browser-safe facet beside `celScope`, `contractFor` and
`moduleGraph`, built lazily. It projects the module graph — an outline item's id is the module-graph
box or row id for the same manifest path — and joins it with the step predicates of the call graph,
the application contract reader, the need table's `environment`, the per-field CEL read chains, the
throws union and the catch coverage. It walks no step array and no `x-telo-ref` itself. A resource
reached from several places is one node, so its size is linear in resources plus edges.

Its JSON form is a document versioned `outlineVersion: 1`, which later versions only extend. The
roots are the module doc's: an Application's boot targets plus the services run-reachability marks
as started; a Library's exported instances. The sections:

- `module` — name, kind (`Telo.Application` / `Telo.Library`), version, description.
- `inputs` — every `variables` / `secrets` / `ports` / `needs` entry, and a Library's `resources`
  inputs: its `env:` / `arg:` binding (in the usage notation `--help` prints) or derived
  `TELO_NEED_…` name, type, whether it is required, its default (never a secret's), and `readBy` —
  the resource fields whose expressions read it.
- `boot` — the targets in order, each with its `when` as written.
- `entryPoints` — every `trigger.inbound` / `trigger.consumer` edge reachable from the roots by every
  use but `schema`: owner, slot path, use, matcher values, handler id, the throws union and, per
  code, the `catches:` entry that renders it or none.
- `resources` — one node per reached resource: kind, module, capability, contract, throws,
  deprecation, the zone attributes it provides, and its body as steps in written order with their
  edges by use (`call`, `detached`, `dependency`).
- `unreached` — declared resources nothing reaches.

The walk stops at an import boundary: an imported instance is a leaf naming its module.

**Nothing is evaluated and nothing is omitted.** Every expression the outline shows — a predicate,
a discriminator, a `when`, a matcher, an argument, a field reading an input — is shown as written
with its tag, plus its static type where the analyzer has one. Every branch appears under its
predicate. A leaf backed by a controller (`JS.Script` included, with no special case) is shown by
kind, name, contract, throws and deprecation, never its configuration body. A secret appears by name
and binding only.

The outline's conformance vectors live in `analyzer/outline-conformance/` (manifest in, expected
`outlineVersion: 1` document out), run by the Node analyzer's tests.

### Entry points are labelled by their matchers

`x-telo-topology-role: matcher` already marks what identifies an entry of an `entries` list, and the
module graph already reads it into each row's `match`. It gains a second placement: a root-level
property of a kind whose root reaches a trigger slot outside any entry list, where it labels every
such slot of the resource. One reader of topology roles replaces the four places that read them ad
hoc today. A `matcher` in neither placement is `TOPOLOGY_ROLE_MISPLACED` — a warning at the kind's
schema, entry-scoped, with no kernel twin since the kernel reads no role. A matcher holding an
expression shows the expression as written.

The standard library declares its trigger selectors: `Scheduler.Interval.every`,
`Scheduler.Cron.cron` and `Scheduler.Cron.timezone` as root-level matchers;
`Http.Server.contentTypeParsers` as an `entries` list with `contentType` its matcher and `parser`
its handler; and every other trigger entry list in `modules/` that lacks one. Each touched module
gets a `telo release add` fragment and its docs updated. Whether an adopting module needs a
`requires: telo:` floor is decided by execution per the root guide: run the previous published CLI's
`check` against it, and add the floor only if that refuses.

### `telo describe <manifest>`

A top-level command rendering `ManifestAnalysis.outline` and nothing else. It takes whatever
`telo check` takes, Libraries included. Through the `Output` seam's `document()`: a text rendering
on stdout by default (a resource reached a second time is a back-reference by name, not a
re-expansion), and the bare `outlineVersion: 1` document under `-o json`. A manifest with error
diagnostics yields no outline: diagnostics on stderr, stdout empty, exit 1 — the `telo needs report`
posture.

### A packaged executable is a manifest source

Every command that takes a manifest (`describe`, `check`, `needs report`, `env template`, `run`)
accepts a packaged executable in its place, recognised by the trailer or Mach-O segment the carrier
already probes and read without executing anything its payload carries. `telo describe ./orders`
therefore works from any installed telo.

### `TELO_APP_CLI=1` — the CLI inside a packaged executable

`TELO_APP_CLI=1 ./orders <cli arguments>` makes the binary the plain telo CLI for that process:
`TELO_APP_CLI=1 ./orders describe ./orders`, `TELO_APP_CLI=1 ./orders run --inspect --debug ./orders
<app args>`.

- `1` means the CLI; unset or empty means the application; any other value is refused before
  anything runs, naming the variable and `1`.
- Every telo start, whatever its distribution and whether or not it carries a payload, removes the
  variable from its own environment before the CLI starts, so no kernel, controller or child process
  sees it. On a telo with no payload it does nothing else.
- `telo runner` sets it on the children it starts when the executable it re-runs carries a payload.
- `./orders <args>` is defined as exactly `TELO_APP_CLI=1 ./orders run ./orders <args>`: the same
  unpack directory, the payload as the cache, the payload-digest analysis key, the working directory
  as the env-file anchor — and the `--debug` log `.telo.debug.jsonl` written in the working
  directory.
- There is no `TELO_OPTIONS` and no per-option environment variable.

`TELO_APP_INFO` is retired: a carrier that finds it set refuses to start and names
`TELO_APP_CLI=1 <binary> package inspect <binary>`. `TELO_APP_DIR` is unchanged.

The packaged-executable contract — trailer, Mach-O segment, payload index, `TELO_APP_CLI`,
`TELO_APP_DIR`, the retired `TELO_APP_INFO`, the `./orders <args>` identity — is written as a
normative spec, `kernel/specs/packaged-application.md`.

### The Rust half

`cli/rust` consumes and strips `TELO_APP_CLI` and refuses values other than `1` in this change. Owed,
and recorded as polyglot debt in the CLI and analyzer guides: the outline facet and the role reader
in `analyzer/rust` (running `analyzer/outline-conformance/`), `telo describe` and the packaged
executable as a manifest source in `cli/rust`, and the `run` dispatch and `TELO_APP_INFO` refusal
when `cli/rust` becomes a carrier.

### Docs

- `docs/guides/packaging-an-app.md`: describe, check and run-with-inspection of a deployed binary
  through `TELO_APP_CLI`; `TELO_APP_INFO` replaced; "no subcommands and no telo flags" corrected.
- `cli/README.md`: `telo describe`, `TELO_APP_CLI`, the `TELO_APP_INFO` sentence replaced.
- `cli/nodejs/CLAUDE.md`: a `telo describe` section; the `telo package` section's "the CLI is
  unreachable" replaced with the switch, its strip rule and the self-invocation rule.
- `analyzer/nodejs/CLAUDE.md`: the outline facet beside the module graph; the matcher's root-level
  placement and `TOPOLOGY_ROLE_MISPLACED`.
- `docs/guides/what-you-get.md`: a "Telo itself" entry — see what an application does, its inputs,
  entry points and failure handling, without running it (`telo describe`) — and the existing **One
  executable** entry extended: the file is also the telo that runs it, so it can be described,
  checked or run with live inspection where it is deployed.
- `apps/authoring-agent/chat/primer.md`: `telo describe` as the way to confirm what a written
  manifest does.
- Changesets for the telo version line packages changed.

## Verify

- `telo describe` of a fixture shaped like `examples/order-webhook` but importing `modules/` by
  relative path (the published scheduler carries no matcher yet) prints every section; its
  `-o json` stdout parses whole and carries `outlineVersion: 1`; both `if` branches of
  `handleDelivery` appear under their predicate text; no field holds `WEBHOOK_TOKEN`'s default;
  `POST /orders` appears under `mount /webhooks`, and `sweeper` is labelled by `every`.
- A manifest that fails `telo check` makes `describe` exit 1 with empty stdout.
- An outline item's id equals the module-graph id for the same manifest path; the matcher values of
  a route equal its module-graph row's `match`.
- `telo needs report` and the outline's needs name the same variables.
- A `JS.Script` leaf and an `Sql.Command` leaf render through one path.
- A third-party kind with a root trigger and a root `matcher` gets labels with no analyzer change; a
  `matcher` on a kind with no trigger gets `TOPOLOGY_ROLE_MISPLACED`.
- `telo describe ./orders`, `TELO_APP_CLI=1 ./orders describe ./orders` and `telo describe` of the
  unpacked entry are byte-identical, text and `-o json`; describing from outside runs nothing from
  the binary (a fixture whose controller throws on import still describes).
- `./orders a b` and `TELO_APP_CLI=1 ./orders run ./orders a b` reuse the same unpack directory, hit
  the analysis stamp writing nothing, and exit the same.
- A controller reading `TELO_APP_CLI`, and a process it spawns, see it unset; `TELO_APP_CLI=yes` is
  refused naming the variable; `TELO_APP_INFO=1 ./orders` refuses and starts nothing;
  `TELO_APP_CLI=1 ./orders runner` starts sessions that run.
- `cli/rust` started with `TELO_APP_CLI=1` behaves as without it, its children do not see it, and it
  refuses `TELO_APP_CLI=yes`.
- The guides, `cli/README.md` and the ledger mention `TELO_APP_INFO` only as retired.
