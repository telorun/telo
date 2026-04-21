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

- **Action:** The kernel validates the provided `variables` and `secrets` against the module's JSON Schema definitions. It also enforces that the `env` object is exclusively accessed by the Root Module.
- **Purpose:** Ensures that the module's contract is fully satisfied and all templates are successfully expanded before proceeding.

### 2.2. `Initialized` (Context Sealing)

**Phase:** End of _Indexes_, transitioning to _Dispatches_.
This event signifies that a resource has successfully allocated its underlying state (e.g., an active database connection or an HTTP server instance).

- **Module Aggregation:** A module emits `Initialized` **only** when all of its internal `resources` and imported dependencies (`imports`) have successfully emitted their own `Initialized` events.
- **Context Sealing (The Immutability Rule):** Upon the module emitting `Initialized`, the kernel finalizes the **Module Context** in memory. According to the core principles, this context **MUST** be sealed and become strictly read-only for the remainder of its lifetime.
- **Outcome:** The kernel enters the _Dispatches_ phase and begins routing ephemeral **Execution Contexts** (triggers/requests) to the module.

_(Note on Fast-Fail Execution: Telo does not utilize a continuous `Ready` state. Because the `Execution Context` is highly ephemeral and deep copying is prohibited for performance, resources must handle connection drops during the Dispatches phase by failing the specific execution instantly.)_

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
