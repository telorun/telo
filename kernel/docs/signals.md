# Telo Signals

## 1. Core Principles

The Telo engine handles asynchronous communication for business logic and resource orchestration exclusively through **Signals**.

- **True Zero-Cost Abstraction:** Signal routing is resolved purely during the DAG build phase. The engine connects listener nodes directly to emitter nodes via memory pointers. At runtime, there is zero string translation, zero event bus lookups, and **zero envelope wrapping**. The raw payload is passed directly.
- **Strict Encapsulation:** Signals emitted by resources within a module are private by default.
- **Explicit Wiring:** Business events use explicit point-to-point **Signals** to guarantee deterministic execution paths.
- **Static Routing:** Signal wiring uses static Resource Paths. Common Expression Language (CEL) is reserved strictly for dynamic runtime payload evaluation.

## 2. Module Boundary & Translation (`exports`)

To expose an internal resource signal to the outside world, a module must explicitly map it in its root-level `exports` block. This categorizes the public contract and provides a clean, domain-specific alias for consumers.

**Syntax (`users-module.yaml`):**

```yaml
kind: Kernel.Module
metadata:
  name: users

# The explicit public contract of this module
exports:
  resources:
    AddUser: InsertUser
  signals:
    # Compile-time alias: maps "UserCreated" to the internal "Success" port
    UserCreated:
      ref: InsertUser.Success
      payload:
        isPremium: "${{ signal.data.role == 'premium' }}"
---
# Internal resource (private by default)
kind: Postgres.Query
metadata:
  name: InsertUser
config:
  sql: "INSERT INTO users..."
```

## 3. Signal Consumption & Direct Wiring

Consumers subscribe to exported signals using the `trigger` property with a static Resource Path.

Because Telo does not wrap payloads in runtime envelopes, the CEL `condition` evaluates the raw data object emitted by the source resource directly.

**Syntax (`consumer-module.yaml`):**

```yaml
kind: Kernel.Import
metadata:
  name: Users
source: example/users@1.0.0

---
kind: Worker.Listener
metadata:
  name: PremiumWelcomeEmail

# 1. Static Wiring (Graph Edge): The engine hardwires this to InsertUser's success port.
trigger: Users.UserCreated

# 2. Dynamic Evaluation (CEL): Evaluates the raw payload directly (no "signal.data" wrapper).
condition: "${{ signal.isPremium == true }}"
do:
  kind: Http.Call
  # ...
```
