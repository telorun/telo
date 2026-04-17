# Telo Module Grants Specification (v1.0 Draft)

## 1. Overview and Philosophy

The Telo micro-kernel operates on a **Default-Deny (Zero-Trust)** architecture. By default, user modules and third-party imports run in a perfectly isolated sandbox with zero access to the host operating system, network, or filesystem.

The `grants` block within an `Import` resource provides an explicit, user-authorized escape hatch. It allows a module to request strictly scoped capabilities (e.g., to accommodate legacy SDKs or native database drivers).

### 1.1 The Pre-Execution Bundling Mandate

To achieve both high performance (e.g., shared memory, zero IPC serialization) and strict security, Telo runtimes must prevent "Deep Dependency Escapes" (where a nested third-party package attempts to call host APIs directly).

**Runtime Creator Mandate:** Any compliant Telo runtime must implement a **Pre-Execution Bundling** or **Ahead-of-Time (AOT) Resolution** step (e.g., using `esbuild` for Node.js, or Wasm linking for Rust/Go). The runtime must traverse and flatten the module's entire dependency tree prior to execution, intercepting all calls to underlying system built-ins and replacing them with runtime-controlled, grant-aware proxies. The execution sandbox must _never_ expose the host's native module loader to userland code.

---

## 2. The `grants` Object Schema

The `grants` property is defined on the `Import` kind. Keys represent the capability namespace, and values define the allowed scope (typically an array of strings representing allowed targets, or a boolean).

### 2.1 Network Capabilities (`net.*`)

Runtimes must intercept all socket creation, HTTP requests, and TCP/UDP bindings.

| Grant Key      | Expected Scope Type | Description & Matching Rules                                                                                                                                                                                                                            |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `net.outbound` | `Array<string>`     | Defines allowed outbound destinations. Runtimes must support explicit hostnames (e.g., `api.stripe.com`), IPv4/IPv6 addresses, and CIDR blocks (e.g., `10.0.0.0/8`). Wildcards (e.g., `*.stripe.com`) may be supported depending on runtime capability. |
| `net.inbound`  | `Array<integer      | string>`                                                                                                                                                                                                                                                | Defines allowed local ports for binding. Runtimes must support specific integers (e.g., `8080`) and string ranges (e.g., `"9000-9100"`). |

### 2.2 Filesystem Capabilities (`fs.*`)

Runtimes must virtualize or intercept filesystem access. **Crucial:** Runtimes must normalize all paths and strictly prevent path traversal attacks (e.g., `../../etc/passwd`) from escaping the granted directory scope.

| Grant Key  | Expected Scope Type | Description & Matching Rules                                                                                                                           |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fs.read`  | `Array<string>`     | Absolute or relative paths allowed for reading. If a directory is specified (e.g., `./templates`), read access is granted recursively to its contents. |
| `fs.write` | `Array<string>`     | Absolute or relative paths allowed for writing/creation.                                                                                               |

### 2.3 System and Environment (`sys.*`, `env`)

These grants bridge the module to the host OS context.

| Grant Key  | Expected Scope Type | Description & Matching Rules                                                                                                                                                              |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`      | `Array<string>`     | Explicit environment variable keys. The runtime must inject _only_ these specific keys into the module's execution context (e.g., `process.env` in Node), leaving all others `undefined`. |
| `sys.run`  | `Array<string>`     | Allowed binary names or absolute paths for child process execution (e.g., `ffmpeg`, `/usr/bin/git`).                                                                                      |
| `sys.info` | `boolean`           | If `true`, allows the module to read host telemetry (OS type, memory usage, CPU arch).                                                                                                    |

### 2.4 Advanced Native Capabilities (`ffi`)

| Grant Key | Expected Scope Type | Description & Matching Rules                                             |
| --------- | ------------------- | ------------------------------------------------------------------------ |
| `ffi`     | `Array<string>`     | Allowed paths to load native dynamic libraries (`.so`, `.dll`, `.node`). |

---

## 3. Runtime Implementation Rules

To be certified as a compliant Telo runtime, the engine must adhere to the following execution rules:

### Rule 1: Isolation by Default

If a module is loaded and no `grants` block is present in its `Import` definition, the runtime must ensure all system calls (network, fs, env, child_process) fail immediately.

### Rule 2: Strict Scope Evaluation

Scopes are allow-lists. If `net.outbound: ["api.stripe.com"]` is granted, an HTTP request to `m.stripe.com` must be blocked unless explicitly listed or covered by a valid wildcard.

### Rule 3: Standardized Security Panics

When a module attempts an action outside of its grants, the runtime must not fail silently. It must throw or panic with a standardized Telo Security Error. The error message should clearly indicate the missing grant to aid developer debugging.

- _Example:_ `TeloSecurityViolation: Module 'PaymentProcessor' attempted outbound network access to 'auth.stripe.com'. Missing grant: net.outbound: ["auth.stripe.com"].`

### Rule 4: Transitive Deny (No Grant Inheritance)

Grants are strictly bound to the specific `Import` instance. If Module A imports Module B, Module B does _not_ inherit Module A's grants. Every module must explicitly declare what it needs, and the Root Manifest must authorize it for that specific module namespace.

### Rule 5: Capability Shimming via Bundling

Runtimes must resolve all deep dependencies (e.g., NPM packages, Rust crates) before execution. During this phase, any requests for host-level built-in modules (e.g., `require('fs')` or `import "net"`) must be intercepted and rewritten to point to the runtime's synthetic, grant-enforcing capability proxies.

### Rule 6: Execution Context Sealing

The execution sandbox (e.g., `vm.Context`, V8 Isolate, or Wasm Guest) must not have access to the host OS module loader. Sandboxed code must only be able to communicate with the specific capability shims injected into its lexical scope by the kernel during the build/boot phase.

---

## 4. Manifest Example

```yaml
kind: Telo.Import
metadata:
  name: LegacyPostgresModule
source: acme/postgres-driver@2.0.0
variables:
  poolSize: 10
secrets:
  connectionString: "${{ resources.HostEnv.values.DATABASE_URL }}"

# Explicit runtime capability authorizations
grants:
  net.outbound:
    - "db.internal.acme.com"
  env:
    - "PG_TELEMETRY_OPTOUT"
  fs.read:
    - "/etc/ssl/certs/ca-certificates.crt"
```
