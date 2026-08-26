# Hub modularization and durable ingest

## Problem

`apps/hub/telo.yaml` is one 2574-line document set holding nine concerns: the relational schema, the origin-read seam, the ingest tracker, the manifest cache, the semantic index, registration, search, the catalog read side, and the HTTP and MCP surfaces. Nothing separates them, so every change is read against the whole file.

Splitting it into imported libraries is blocked by an asymmetry in the module system. A library declares two kinds of input — `variables` and `secrets`, both scalar — and one kind of output, `exports.resources`. **Instances flow up and never down.** Each import declaration also builds its own child module context with its own instances, so two libraries importing a third get two of everything in it. Measured: an application importing two libraries that each import one library owning a SQLite connection fails with `no such table`, because the writer and the reader are on different connections; the same three rewired as a chain, each re-exporting, share one. So any set of libraries that must share a resource has to be linearized into a total order, with every layer re-exporting the union of everything beneath it — which gives away the self-containment a split is for.

That is a correctness constraint here, not a preference. `durable-journal-postgres` attests exactly-once only when the journal writes on the same connection as the work it records; a second pool silently degrades every ingest region to at-least-once.

A second defect surfaced while designing the split, in the other mechanism a library has for shipping behaviour: a `Telo.Definition` whose body is written in `resources:`. That body cannot read the call's own arguments:

```yaml
kind: Telo.Definition
metadata: { name: Resources }
capability: Telo.Invocable
schema:
  properties:
    connection: { x-telo-ref: { kind: Sql.Connection, use: dependency } }
inputType:
  type: object
  properties:
    q: { type: string }
resources:
  - kind: Sql.Query                      # ✓ a leaf wired from the injected slot
    metadata: { name: fuse }
    connection: !cel "self.connection"
  - kind: Run.Sequence                   # ✓ a multi-step body is fine
    metadata: { name: body }
    inputType:                           # what `inputs` below must type against
      kind: Telo.JsonSchema
      schema:
        type: object
        properties:
          q: { type: string }
    steps:
      - name: rows
        invoke: !ref fuse                # ✓ a sibling reference resolves
        inputs:
          bindings:
            - !cel "inputs.q"            # ✗ 'inputs' is not defined
      - name: each
        value: !cel "steps.rows.result"  # ✓ steps resolves
invoke: !ref body
inputs:
  q: !cel "inputs.q"                     # ✓ legal here — the top-level sibling
```

Measured: with that one binding written as a literal the document is `✓ No issues found`; as an expression it is

```
resources[1].steps[0].inputs.bindings[0]: 'inputs' is not defined
  (available: variables, secrets, resources, ports, module, self, request, result, steps, error)
```

and an iteration's `item` fails the same way (`resources[0].collection: 'inputs' is not defined`, `resources[0].steps[0].value: 'item' is not defined`). CEL there is typed in the *enclosing* definition's scope rather than the nested kind's, so `inputs` and `item` are unknown while `error` is offered everywhere regardless of whether a `catch:` is in scope. The kernel matches: its deferral set is the four names `request`, `result`, `steps`, `error`, so an `inputs` reference would be substituted when the persistent child is created — once, before any call exists. This is why no standard-library template has a body of more than one dispatch.

Ingest has its own problems independent of layout. A pass writes five unbatched statements per version, so a crash mid-pass leaves a version row with no kinds, and `/register` runs the whole ingest inside an anonymous request.

## Solution

### Resource inputs on a library

A library gains a third input block beside `variables` and `secrets`, declaring the instances it requires from whoever imports it. Each entry is constrained **by kind only**, through the same alias-qualified grammar every other slot uses; the importer supplies references at the import's object form. There is no `use:` on an entry: the boundary is a dependency edge for init order whatever the library does with the instance, so the token would carry nothing the edge model reads, and — since the flattened application analysis drops the library doc — it would be the only app-level statement about how a handed-down instance is reached, and an unchecked one. Detach and zone-attribute checks run in the library's own pass, where the call site is; a zone requirement reaching an injected input cannot be discharged there and **defers to the injection site**, which is the existing `ZONE_REQUIREMENT_DEFERRED` vocabulary rather than a new rule. **An entry synthesizes a kind-only declaration in the library's own scope.** That model has to be stated, because a library's internals are validated in the library's own pass — the flattened application analysis drops the library doc — so with nothing behind `connection`, `!ref connection` would have nothing to resolve against. Kind-only is enough because it is already what a ref slot gets: a reading types its `status:` half from the kind, closed so a typo below it is `CEL_UNKNOWN_FIELD`, and leaves the flat half open, since no manifest declares what `snapshot()` returned. So `!ref connection` at a ref slot and `resources.connection.<field>` in CEL answer exactly as they do for a locally declared resource.

Two checks are declaration-derived and cannot answer inside the library, so they **move to the injection site**, where the real declaration is in hand: `x-telo-schema-projection-from`, which projects one instance's own entries and would otherwise report `SCHEMA_PROJECTION_FROM_UNRESOLVED` at every consuming slot, and `OBSERVED_STATE_NEVER_RUN`, which a library cannot answer about a resource it does not declare. Neither costs the hub anything — its six libraries take a connection, a journal, bucket put/get, embed passage/query, vector match/upsert/removal, a shell host and a rate-limit guard, and none of those is a projection source.

The rest lands on machinery that already exists. The injection site is checked by the ref-slot rules (does the supplied resource's kind satisfy, transitively, what the library declared), an unsupplied required entry is the same failure as a missing required variable, and init order falls out on its own: the import resource gains a dependency edge per injected target, captured at `create()` like any reference, so a cycle is caught by the graph that already catches cycles.

One rule is genuinely new. **An injected resource is borrowed, not owned.** Its effect frame belongs to the scope that declared it, so the child context must never include it in its own teardown — otherwise a library's teardown closes the application's connection.

This is the inward half of a symmetry the module system was missing, and it is what makes the hub's libraries a DAG: the application owns the single connection and hands it to every library that reads or writes it.

### Library singletons

`resources:` hands one instance DOWN to several libraries. The other half is a library that OWNS an instance several libraries need — `hub-origin`, which every ingest and registration path reaches for `telo module versions|digest|manifest`. By default each import declaration builds its own child scope, so two libraries importing origin get two of everything in it.

**`lifecycle:` on a `Telo.Library`** names the choice: `isolated` (the default, and what every published module was written against) is one instantiation per import declaration; `shared` is one for the whole application, which every import resolves to at any depth. The field was already declared on `Telo.Application` and read by nothing.

The root owns a singleton and every import borrows it — the same rule an injected resource follows. Its child scope is spawned under the ROOT rather than under whichever import reached it first, and it is torn down after every other root child, so a borrower's own inverses still find it alive. Initialization is memoized on the registry entry rather than on an import, because the import that REGISTERS a singleton is not necessarily the one whose `init()` runs first. Every import of one must agree: different variables, secrets or resource instances is a hard error naming both aliases and the differing key, and a per-import `logging:` / `runtime:` override is refused, since both scope a subtree that is no longer one import's.

### Template bodies are declarations of their own kind

One rule closes the second defect, and it applies at the two places a definition writes a body for another kind — `resources:` entries and a `base:` mapping. The analyzer resolves CEL there through the nested kind's own annotations: its `x-telo-eval` modes, its `x-telo-context` regions, its step-body fragment — with `self` merged in from the enclosing definition's `schema:`. So `inputs` types from **that nested resource's own `inputType:`** — never the enclosing definition's, which the template reaches the body through a mapping that is free to rename or narrow, so typing against it would accept names the body never receives and reject the ones it does. A body wanting checked inputs declares an `inputType:`; one without leaves the binding open. `item` types from the iteration it sits in, and `error` is offered only inside a `catch:`, exactly as in an ordinary resource declaration.

The kernel stops keying deferral on a name list and instead leaves untouched every node the nested kind marks runtime-eval or covers with a context region, through the containment matcher both halves already share. **`self` stops being substituted eagerly** — one pure `self.<path>` node excepted, which stays navigated directly at creation because it must yield the live instance and CEL cannot carry one; that form is how an injected reference reaches a nested ref slot. Every other node is left compiled, and the child context binds `self` as the published-reading view alongside the nested kind's own `inputs`, `item` and `steps`. The nested body is a persistent child created once, so those three are supplied per dispatch by the nested kind's own controller from its own invocation — never carried in from the enclosing template scope.

Substituting `self` at creation *and* deferring by region cannot both hold at node granularity, and getting that wrong is not theoretical: `crud` reads `self.singular` and `self.model.schema` from inside the `routes[]` of an `Http.Api` declared in a template body, and those nodes sit in context regions. Binding `self` into the child's scope instead is what keeps them working — and it **removes** the current restriction that one expression may not mix `self` with a call-time name, rather than widening it from four names to whole regions.

The call graph and the zone-containment walk gain the same reach. Without it `DURABLE_DETACH_FORBIDDEN`, `DURABLE_UNJOURNALABLE_RESULT` and `ZONE_ATTRIBUTE_VIOLATED` are silently vacuous on any body declared inside a kind — a check that reports nothing being worse than one that does not exist.

This is independent of the hub: nothing in the split depends on it once libraries take resource inputs. It lands here because it was found here, it is a two-name hole in an otherwise working mechanism, and until it closes a library cannot ship a kind whose body does real work.

### Six libraries and a composition root

`apps/hub/hub-schema.yaml` owns the tables and the two SQL functions; `hub-origin.yaml` reads a module from its origin (versions, digest, manifest) and owns the ref and version grammar; `hub-ingest.yaml` turns one version's manifest into bucket bytes, rows and vectors; `hub-search.yaml` owns categories and both searches; `hub-catalog.yaml` owns the keyed read side and the cached-manifest read; `hub-registry.yaml` owns the ref gate, validation, the row insert and scheduling.

`hub-origin` is `lifecycle: shared`; `hub-ingest` and `hub-registry` import it and forward the shell host they were handed. Every other library is a leaf. That is the shape a singleton makes available and a `Run.Sequence`-constrained resource input does not: passing origin's entry points down as instances would keep the graph flat at the cost of a constraint that says nothing a reader can check.

Each declares its resource inputs, keeps its own SQL at its own call sites, and exports the one or two entry points its consumers name. Their internals stay flat — `Run.Sequence`, `Run.Iteration` and the rest, exactly as written today — so the step bodies move essentially verbatim. Scalars that are genuinely per-deployment (`vectorMinScore`, `teloBin`) stay `variables:`, which is what `variables:` is for.

`apps/hub/telo.yaml` keeps env binding, the one connection, bucket, embedder, vector index and shell host, the imports that hand those to the libraries, the cron, the resumer, the HTTP and MCP surfaces, and `targets`.

### Durable ingest

**One durable run per ingest attempt of a `(ref, version, digest)`**, identified `ingest:<rev>:<ref>@<version>:<digest>:<attempt>`. Enumeration and digest resolution stay ordinary work outside the run — cheap, re-runnable, and the cron tick's job. `Scheduler.Cron` replaces the `Run.Loop` and `Timer.Delay` pair.

The workflow is an ordinary `DurableLocal.Workflow` instance in `hub-ingest`, exported by name, so the application's `Local.Resumer` and `Local.Schedule` reference it directly. The per-version writes run inside `Sql.Transaction` on the journal's connection, earning `perStep`; the bucket write stays outside it, so a rollback cannot un-journal a completed put.

**`hub-ingest` declares the journal itself, over the connection it was handed, and exports it.** The journal attests `writesInside` by asking its own connection whether it binds the zone — a runtime identity check with no static counterpart — so handing the library a connection *and* a journal as two unrelated entries would make a composition-root mistake produce a hub that ingests correctly, passes `telo check`, and silently loses exactly-once, visible only as `durable.zone.mode: collapsed`. Declaring it where the connection already is makes the disagreement unrepresentable rather than checkable. Nothing outside needs a journal to be passed in: `Resumer` and `Schedule` take the workflow, and `Local.Status` behind `/register/status` reads the exported instance.

**The authoritative "have I ingested this" record is the row, not the run.** `module_versions` gains `ingest_rev` — the revision that last ingested this version — beside its existing `digest`, plus `last_error` and a last-attempt timestamp; `ingest_rev` subsumes the `integrity IS NULL` and `runtimes_asked` backfill probes, since one sentinel refreshes the whole row. The cron schedules a version when its digest moved, when `ingest_rev` is behind `<rev>`, or when a recorded failure is past its backoff.

The run id then carries an `<attempt>` ordinal from the same row, and that is what makes recovery possible at every granularity an operator needs: clear one row's error to re-ingest one version, a module's rows to re-ingest a module, bump `<rev>` for all of them. `Local.Schedule` still refuses a taken id, so two overlapping cron passes reading the same ordinal collapse to one run. Transient failure is absorbed inside the run by step `retry:` — a ceiling above 30 s parks rather than sleeps, so an origin outage costs nothing while it waits — and a run that fails anyway records `last_error` and stops, with the row deciding whether it is ever attempted again.

`/register` keeps its full sanity check synchronously (rate limit, shape gate, `module versions`, `module manifest`, `Telo.Library` confirmed, row inserted), then schedules and answers `202`; `GET /register/status?ref=` over `Local.Status` is what a client polls. Registration and the cron pass reach the same code path — both enumerate and schedule against the same predicate.

## Decisions

- **Resource inputs, rather than a chain or injected kinds.** Both alternatives were designs around the missing feature. A chain shares one instance but imposes an arbitrary total order and a growing re-export union; libraries exporting *kinds* configured by the consumer avoids that but forces every body into a template, which is a rewrite of the hub's step bodies for no gain once instances can be handed down.
- **The template-body fix ships here even though the hub no longer needs it.** Two names, `inputs` and `item`, are the whole gap, and a defect found while designing a change is cheapest to close in it. Rejected: deferring only those two names in the kernel — that leaves the analyzer offering `error` outside a `catch:` and every nested kind's context bindings unknown, which is the same hole seen from other sides.
- **The library-side block is spelled `resources:`**, mirroring `variables`/`secrets`. It collides in polarity with `Telo.Definition.resources` — instances a kind creates internally — but the two never appear on the same document kind, and naming an input block after what it holds is the established rule.
- **Borrowed, not owned.** An injected resource is torn down by its declaring scope only; a child context that reverted one would close the application's connection out from under everything else.
- **Libraries import each other where the dependency is real, rather than every library being a leaf.** `hub-ingest` and `hub-registry` both need the origin reads, and `hub-registry` needs the ingest workflow. The alternative — passing entry points down as resource inputs to keep the graph flat — constrains them to `Run.Sequence`, which is a constraint nothing can check. `lifecycle: shared` is what makes the import the better answer: origin is instantiated once whichever way it is reached. `hub-registry` still takes the workflow as an INJECTED input rather than importing `hub-ingest`, because importing it would produce a second workflow over one journal — exactly the split the durable design exists to prevent.
- **An entry is constrained by kind, with no `use:`.** The boundary is a dependency edge whatever the library does with the instance, so `use:` would read as an app-level claim about internal call sites that nothing checks — and the flattened analysis drops the library doc, so nothing *could* check it there. Rejected: forwarding the library's internal edges into the consumer's call graph, which is the only variant that keeps zone and detach checks live across the boundary and is far larger than the gap it closes.
- **`hub-ingest` declares its own journal over the injected connection.** `writesInside` is a runtime identity check on the journal's own connection, so passing a connection and a journal separately would let a composition-root slip pass `telo check` and silently lose exactly-once. Rejected: injecting the journal and deriving the connection from it — a ref slot yields an instance, and there is no navigation from a journal to the connection inside it.
- **The row gates, the run id dedups.** Letting the run's existence be the once-only record was wrong in a way worth recording: `DurableLocal.Schedule` refuses a taken id whatever the run's status, and `DurableLocal.Resume` refuses a `completed`/`failed`/`cancelled` run outright — it only clears a park — while the journal exposes no delete at all. So a terminal id is permanently burnt, and a version that failed for a reason since fixed in the hub's own code, at an unchanged digest, would have had no recovery short of re-ingesting the whole registry. `ingest_rev` plus an `<attempt>` ordinal restores per-version, per-module and global re-ingest, and the ordinal costs a write only for versions that actually need one.
- **Two overlapping passes still collapse to one run**, because both read the same ordinal and `Schedule` refuses the duplicate — which is why the ordinal does not reintroduce the concurrency hazard that made an attempt counter look unattractive.
- **Permanent failure stops.** Retrying an artifact that is no longer a Telo module every fifteen minutes forever is the behaviour to remove; clearing the row's error is the operator's per-version override.
- **A terminal run's id being unreleasable is a generic gap, raised separately.** Every consumer using "the id is the once-only record" hits it, not just the hub. `Resume` accepting a terminal run behind an explicit flag, recorded as the override already is, fits `durable-local`'s own stated posture — parking is a hold, not a grave — better than a discard that deletes the record. The hub does not wait for it, because the row gates.
- **No separate worker application.** The property that matters is that the request path never ingests, and scheduling gives it — a workflow start executes in the caller's process, a schedule does not. Journal claims are one conditional `UPDATE`, so a second replica becomes a worker with no code change.
- **`/register` answers `202`.** `200` currently means *searchable*, and once indexing is asynchronous that is a lie. Updates `apps/hub-web` and `apps/hub/tests/e2e/register-route.yaml`.
- **`TRACK_INTERVAL` and `TRACK_LOOP` become `TRACK_CRON`** plus a gated target — an operational break for whoever deploys the hub.
- **Every resource instance renames to camelCase**, clearing the 43 `NAME_CASE_CONVENTION` warnings while the file is rewritten anyway.
- **Each hub library declares a `requires: telo:` floor**, verified by running the previous published CLI against it and confirming it rejects — resource inputs widen what a manifest may say, so a module using them is unreadable to an older runtime. The same obligation attaches to any module whose template body reads `inputs` or `item`, for the same reason.

## After the change

A library states what it needs and stays flat inside:

```yaml
# apps/hub/hub-search.yaml
kind: Telo.Library
metadata: { name: HubSearch }
imports:
  Sql: oci://ghcr.io/telorun/sql@…
  Run: oci://ghcr.io/telorun/run@…
resources:                             # kind-only — no `use:` at this boundary
  connection: { kind: Sql.Connection }
  embed:      { kind: Embedding.Query }
  vectors:    { kind: VectorStore.Match }
variables:
  minScore: { type: number, default: 0.3 }
exports:
  resources: [searchResources, searchModules, categoryVocabulary]
---
kind: Sql.Query
metadata: { name: fuse }
connection: !ref connection          # injected — named like any local resource
---
kind: Run.Sequence
metadata: { name: searchResources }
steps:
  - name: embedded
    if: !cel "inputs.q != ''"
    then:
      - name: vector
        invoke: !ref vectors
  - name: rows
    invoke: !ref fuse
    inputs:
      sql: …
      bindings:
        - !cel "inputs.q"
        - !cel "steps.embedded.result"
```

The application owns the instances and hands them down:

```yaml
# apps/hub/telo.yaml
imports:
  Search:
    source: ./hub-search.yaml
    resources: { connection: !ref db, embed: !ref embedQuery, vectors: !ref vectorMatch }
    variables: { minScore: !cel "variables.vectorMinScore" }
  Ingest:
    source: ./hub-ingest.yaml
    resources:                         # no journal here — hub-ingest declares it
      connection: !ref db              # over this connection, and exports it
      bucket: !ref putManifest
      embed: !ref embedPassage
      vectors: !ref vectorUpsert
---
kind: Local.Resumer
metadata: { name: resumer }
workflow: !ref Ingest.ingestVersion
---
kind: Scheduler.Cron
metadata: { name: reconcile }
cron: !cel "variables.trackCron"
invoke: !ref Ingest.scheduleDueVersions
```

One connection, six leaves, and no library knows any other exists.
