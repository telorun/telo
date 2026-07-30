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
- **Context Sealing (The Immutability Rule):** Upon the module emitting `Initialized`, the kernel finalizes the **Module Context** in memory. According to the core principles, this context **MUST** be sealed and become strictly read-only for the remainder of its lifetime.
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

## 3. Dependency Graph & Topological Ordering

To prevent "Deep Dependency Escapes" and maintain strict Zero-Trust isolation, Telo runtimes mandate a **Pre-Execution Bundling** or **Ahead-of-Time (AOT) Resolution** step. This requires the kernel to strictly enforce the order of lifecycle events across the dependency tree:

- **Bottom-Up Initialization:** A parent module cannot emit `Validated` or `Initialized` until all of its imported dependencies (proxies) have successfully reached the `Initialized` state. The Root Module is always bootstrapped and initialized last.
- **Top-Down Teardown (Reverse Order):** During kernel shutdown, the topological order must be reversed. An imported dependency **MUST NOT** receive a `Draining` or `Teardown` signal as long as a parent module still holds a reference to it and is actively processing `Execution Contexts`.
- **Capabilities Lifecycle:** Because sandboxed code relies entirely on kernel-injected capability shims instead of host APIs, all security capabilities (`Telo.Capability.*`) must be the absolute last resources to undergo `Teardown`. This ensures no draining module loses network or filesystem proxy access prematurely.
