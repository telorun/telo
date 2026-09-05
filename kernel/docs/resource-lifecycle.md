---
description: "v1.0 spec: resource lifecycle stages (Validated, Initialized, Draining, Teardown) and topological ordering across dependency graphs"
---

# Telo Resource Lifecycle Specification (v1.0 Draft)

## 1. Overview

Telo is an execution engine (Micro-Kernel) that runs backend logic defined entirely in declarative YAML manifests. Because Telo routes execution based on a `Kind.Name` registry and relies on strictly isolated contexts, managing the deterministic lifecycle of resources and modules is critical.

This specification defines the lifecycle events that orchestrate how modules and their internal resources transition through the engine's core operational phases: _Loads_, _Expands_, _Indexes_, and _Dispatches_.

## 2. The Lifecycle Stages

Every resource instance and module in the Telo dependency graph must transition through the following strictly ordered lifecycle events:

### 2.1. `Validated` (Contract Verification)

**Phase:** Post-_Loads_ and Post-_Expands_.
Before the kernel allocates memory or initiates any heavy I/O operations, it must verify the structural integrity of the module.

- **Action:** The kernel validates the provided `variables` and `secrets` against the module's JSON Schema definitions. Host environment variables are bound only through the root Application's `env:`-keyed `variables:`/`secrets:`/`ports:` entries; child modules never touch the host environment.
- **Purpose:** Ensures that the module's contract is fully satisfied and all templates are successfully expanded before proceeding.

### 2.2. `Initialized` (Context Sealing)

**Phase:** End of _Indexes_, transitioning to _Dispatches_.
This event signifies that a resource has successfully allocated its underlying state (e.g., an active database connection or an HTTP server instance).

- **Module Aggregation:** A module emits `Initialized` **only** when all of its internal `resources` and imported dependencies (`imports`) have successfully emitted their own `Initialized` events.
- **Context Sealing (The Immutability Rule):** Upon the module emitting `Initialized`, the kernel finalizes the **Module Context** in memory. This context **MUST** be sealed and become strictly read-only **for the remainder of that generation**.

  The seal is scoped to a generation rather than to the process, because the thing it protects against is a context mutating *underneath running dispatch* — not a context ever changing at all. A **reconciliation** ends one generation and opens the next: the resources whose declarations moved are unwound, the new declarations are registered, and the context seals again. What must never happen is a registration landing in a sealed context, which is the failure the rule exists to name: a resource that registers an inline definition into a module after boot lands in a pending queue nothing will drain again, so it is never created and its dispatch fails with `ERR_RESOURCE_NOT_FOUND`.

  A process that never reconciles has exactly one generation. `Kernel.reconcile()` opens the next one: it re-reads the entry, diffs the declarations (`diffManifests`), unwinds what moved together with everything holding it, re-registers and re-initializes. `telo run --watch` does not use it yet and still rebuilds a whole kernel per edit.

  **What it will not narrow**, each returning `restartRequired` with nothing unwound:

  - **A module other than the entry moved.** The runtime manifest set is entry-only — an imported library's resources live in the child context its `Telo.Import` owns and never reach the diff.
  - **The application document changed.** `variables` / `secrets` / `ports` / `logging` resolve once for the whole application, so a change there has no bounded impact set.
  - **A `Telo.Definition` or `Telo.Abstract` changed.** Kind registration is once per kernel — the definition registry only ever adds — so the previous registration would survive the reload and the running kernel would enforce a weaker contract than `telo check` does against the same file.
  - **A resource in the impact set was resolved by name** during initialization. Its holders are unknown, so no closure over the declared edges is an answer (`resource-references.md` §1).
  - **A resource in the impact set has already been run.** Boot targets run once; re-initializing a started resource would leave it constructed and idle — for a server, listening on nothing — while reporting it as rebuilt.

  **Signatures are taken at load time, not at reconcile time.** The kernel registers the very manifest objects it loaded, and resolving a reference writes a live instance into one — a boot target's `!ref` above all. A signature taken later renders those slots opaque and reports a change that never happened, which on the application document means escalating every reconciliation there is.

  **A failure after the unwind leaves the kernel degraded**, and says so (`ERR_RECONCILE_FAILED`): the resources are already gone and there is no state to roll back to. Only the `restartRequired` returns guarantee that nothing was touched.

  Reconcile also assumes a **stable environment**: it compares declarations, so a `!cel "variables.port"` whose environment variable moved behind it is not detected. `telo run` resolves the environment once at startup, so this holds for a watch loop and would not for a host that re-reads the environment.

  It is not incremental in cost, only in effect. Every file of the previous graph is dropped from the loader cache and re-read, and the whole analysis pass re-runs; what it saves is instance construction.
- **Outcome:** The kernel enters the _Dispatches_ phase and begins routing ephemeral **Execution Contexts** (triggers/requests) to the module.

_(Note on Fast-Fail Execution: Telo does not utilize a continuous `Ready` state. Because the `Execution Context` is highly ephemeral and deep copying is prohibited for performance, resources must handle connection drops during the Dispatches phase by failing the specific execution instantly.)_

#### 2.2.1. Reporting a Failed Initialization

The init loop retries until no pass makes progress, so when it gives up, every resource downstream of a failure is also unfinished. Reporting them flat means one actionable line buried under N shadows of itself, and the shadows come first (a resource that never got created is listed before one whose `init()` threw). The kernel therefore **classifies** the failure set before raising `ERR_RESOURCE_INITIALIZATION_FAILED`.

**What makes an entry derived is its error CODE, never its edges.** An entry is derived when it carries `ERR_LOCAL_REF_PENDING` or `ERR_CROSS_MODULE_REF_PENDING` — a deferral, which says the resource never ran and so has nothing of its own to report. Everything else is a **root cause**, including a resource that references a failed dependency *and* fails its own validation: an edge proves an edge exists, not that this entry's failure came from it, and collapsing on that basis would swallow a real error the author has to fix. (The edge is not trustworthy on its own terms either — `collectResourceRefs` walks `with:`-scoped inline declarations, whose names resolve scope-locally, so a scoped `!ref Db` can collide with a failed module-level `Db`.)

Reference edges are used for **attribution only**: they name which failure a deferred entry is waiting on. `blockedBy` is the **root** of the chain, not the immediate blocker, since that is the name a reader has to go fix; the walk stops at the first entry that is not itself derived. A deferral with no visible edge (a `${{ resources.X }}` read) is still derived, just unattributed. Edges are captured at `create()` time, before Phase-5 injection replaces refs with live instances, so the walk never descends into a controller's object graph.

Classification never hides everything: if no entry survives as a root (every failure is a deferral), the whole set is reported unclassified.

The diagnostics of a **nested** context — an import initializing its library's resources — are attached to the importing entry as `children` rather than flattened into its message, so the child's own root causes stay distinguishable from the child's own cascade and the error count sees the real leaves rather than one `Telo.Import`. A child context's roots are reported even when the entry wrapping them is itself collapsed — they are not shadows of the *parent* context's failure. Both the aggregate message and the importing entry's headline come from `summarizeInitFailures(diagnostics)`; neither is recovered by re-parsing the other's rendered text.

Renderers consume the classification (`derived` / `blockedBy` / `children`); they do not re-derive it. The CLI prints root causes in full and collapses each chain to one line (`3 resources blocked by GrantDb: …`), with `--verbose` printing every entry.

### 2.3. `Draining` (Graceful Degradation)

**Phase:** Initiating Kernel Shutdown.
When the kernel receives a termination signal, it must safely halt operations without breaking active requests.

- **Action:** The kernel broadcasts the `Draining` signal to modules and resources.
- **Behavior:** The resource **MUST** stop accepting new dispatch requests from the kernel. However, it must remain active to allow any currently running, ephemeral `Execution Contexts` to complete their operations.
- **Purpose:** Prevents data corruption and ensures graceful shutdown for in-flight executions.

### 2.4. `Teardown` (Resource Destruction)

**Phase:** Final Kernel Shutdown.
Once a resource has safely drained its active execution queues, it undergoes physical destruction.

- **Action:** The resource releases its memory, closes connections, and emits `Teardown`.
- **Outcome:** The kernel drops the resource's references from the in-memory registry and permanently destroys its `Module Context`.

#### 2.4.1. Ordering the Cascade

Tearing a resource down is unwinding its effect frames; there is no `teardown()` to call. What orders one resource's own inverses is the frame (LIFO, innermost frame first — see the revertible-effects spec). What orders resources *against each other* is this cascade, and its one rule is that **a consumer unwinds before everything it holds**, so an inverse that hands a connection back, closes a subscription, or deregisters from a provider still finds that provider alive.

A context tears down in two steps.

**Its own resources first**, ordered by `teardownPriority` as a hard tier and, within a tier, reverse-topologically over the reference edges captured at `create()` time — before Phase-5 injection replaces refs with live instances, so the walk sees plain objects and cannot wander into a controller's object graph. A cross-module `!ref Alias.name` is projected onto the local `Telo.Import`, which is the resource whose teardown takes the library's own resources with it. Reverse insertion is the tiebreak.

`teardownPriority` remains a tier rather than becoming another edge, because it states an edge nothing captured: a log sink is reached through `ctx.log`, not through a ref slot, so no walk of the manifest can discover the resources that will log on the way down. Allowing a discovered edge to reorder across tiers would let it override a declaration made precisely because the edges are not all discoverable. A cycle emits in tiebreak order rather than raising — teardown MUST always run to completion.

**Then a sweep of any child context still standing.** A child context that belongs to a resource is torn down by that resource's own inverse: an import's `init()` returns `child.teardownResources()`, and so does a template's. It therefore unwinds at its owner's position in the step above, which is the position the edges put it at. Running a child cascade *ahead* of the own-resource loop — as the kernel previously did — tore every imported library down before any resource of the importing context, so a resource holding `!ref Alias.name` unwound against a provider that was already gone.

The sweep still runs, afterwards, because `teardownResources` is idempotent and two shapes reach it with no owner to claim them: a `lifecycle: shared` library, which is spawned under the root and deliberately gives no importer a claim on it, and an import whose `init()` never ran to register one. `teardownPriority` on a *context* orders that sweep, which is now library-against-library only.

**Part of a context can unwind on its own.** `unwindResources(names)` runs the same order restricted to a selection and leaves everything else running — what a reconciliation does once it knows which declarations moved. It is safe only because the selection is closed under holders (§2.4.2): none of the resources left standing holds anything in it. The context keeps its state, and no child is swept, since a child belonging to an unwound import goes down with that import's own inverse exactly as at teardown.

Both directions of the ordering fall out of the single order rather than out of a rule about children. A library that borrows a parent instance through `resources:` unwinds before that instance, because its import initialized after it; an app resource holding a library export unwinds before the import that owns the library. Neither "children first" nor "own resources first" is correct on its own, which is why the position of the *owning resource* is the rule.

#### 2.4.2. Who Else Breaks When One Resource Is Rebuilt

Teardown reads the reference edges forward. Reconciliation reads the same edges backwards: given resources whose declarations moved, `impactedBy` returns those resources plus everything that transitively **holds** one.

A holder has to go with what it holds. Phase-5 injection wrote a live instance into its reference slot, so rebuilding the target leaves it pointing at an object nothing will call again. There is no version where the holder keeps running, which is why replacing one resource restarts everything above it — a cost to state, not a defect to fix.

Two kinds of edge feed it: a reference slot, and a CEL read. `!cel "resources.db.dsn"` is expanded and baked in at create time and leaves no reference behind, so read edges are captured from the DECLARATION — without them a reader keeps serving the previous load's value with nothing reporting it. Unwinding a resource also drops its published reading, so an expansion that would otherwise find a stale value defers instead, exactly as it would on a fresh boot.

The closure is exact over **declared** edges only. A controller that resolves a sibling by name has a dependency no manifest walk can see, so the kernel records such a resolution when it happens during initialization (see `resource-references.md` §1) and `impactedBy` returns those names **alongside** the closure rather than absorbing them. It does not expand the set to "every resource here": that would sweep in the module document, which is not a resource anything can unwind and re-register, and would present a whole-context rebuild as a narrowing. The caller escalates instead, naming what forced it.

## 3. Dependency Graph & Topological Ordering

To prevent "Deep Dependency Escapes" and maintain strict Zero-Trust isolation, Telo runtimes mandate a **Pre-Execution Bundling** or **Ahead-of-Time (AOT) Resolution** step. This requires the kernel to strictly enforce the order of lifecycle events across the dependency tree:

- **Bottom-Up Initialization:** A parent module cannot emit `Validated` or `Initialized` until all of its imported dependencies (proxies) have successfully reached the `Initialized` state. The Root Module is always bootstrapped and initialized last.
- **Top-Down Teardown (Reverse Order):** During kernel shutdown, the topological order must be reversed. An imported dependency **MUST NOT** receive a `Draining` or `Teardown` signal as long as a parent module still holds a reference to it and is actively processing `Execution Contexts`. See §2.4.1 for how the cascade achieves this — the reversal is over the reference edges, not over registration order, and an imported library's position is the position of the import that owns it.
- **Capabilities Lifecycle:** Because sandboxed code relies entirely on kernel-injected capability shims instead of host APIs, all security capabilities (`Telo.Capability.*`) must be the absolute last resources to undergo `Teardown`. This ensures no draining module loses network or filesystem proxy access prematurely.
