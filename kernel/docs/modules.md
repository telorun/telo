# Telo Module Specification (v1.0 Draft)

## Overview

A Telo Module is a self-contained, encapsulated package of application logic, services, or system components. It enforces a logical boundary between its internal implementation details (resources) and its public interface. This specification defines how modules declare their inputs, manage internal state, and expose specific capabilities to external consumers.

---

## 1. Module Contract (`kind: Kernel.Application` / `kind: Kernel.Library`)

Every module file begins with exactly one `Kernel.Application` or `Kernel.Library` document — the manifest and public interface for the package. Applications are runnable entry points; Libraries are units imported by others. Both use JSON Schema validation for their inputs.

- **`metadata.name`**: Global identifier in the package registry. Kebab-case slug (e.g., `user-service`) to remain URL-friendly and consistent with standard registry patterns.
- **`variables`**: Standard configuration properties required by the module. JSON Schema object properties. Per the style guide, use **camelCase** (e.g., `dbConnectionString`).
- **`secrets`**: Sensitive inputs. Also JSON Schema object properties, handled separately to ensure secure injection and prevent accidental exposure in logs.
- **Optionality (No `required` block)**: Requirement validation is handled via defaults. Mandatory inputs are defined without a `default`. Optional inputs must be explicitly defined with `default: null`.

**Application-only:**

- **`targets`**: Optional. Resources to run once initialization completes. Applications whose work is carried entirely by auto-start Services (e.g. an HTTP server) may declare no targets.
- **`lifecycle`** / **`keepAlive`**: Runtime lifecycle hints.
- Receives `env: process.env` when loaded as the root manifest. Never valid as the target of a `Kernel.Import`.

**Library-only:**

- **`exports.kinds`**: Which resource kinds this library exposes to importers.
- `targets`, `lifecycle`, and `keepAlive` are forbidden — libraries are not lifecycle participants.
- Never runnable via `loadFromConfig`; loaded only through `Kernel.Import`.

---

## 2. Including External Manifests

A module can load additional manifests from other files into the same module scope using the `include` field. This allows splitting a large module definition across multiple files while keeping them logically united under one module. Glob patterns are supported.

```yaml
kind: Kernel.Library
metadata:
  name: user-service
  version: 1.0.0
include:
  - ./routes.yaml
  - "handlers/**/*.yaml"

variables:
  dbConnectionString:
    type: string

exports:
  kinds:
    - UserApi
```

All resources defined in included files behave as if they were declared in the same file — they share the same module namespace and have access to the same `variables`, `secrets`, and `resources` context.

**Constraints on included (partial) files:**

- Must not contain `kind: Kernel.Application`, `kind: Kernel.Library`, `kind: Kernel.Import`, or `kind: Kernel.Definition`. These system kinds are reserved for the owner `telo.yaml`.
- Resources that omit `metadata.module` are automatically bound to the including module, rather than the `default` module. Explicitly setting `metadata.module` on a resource in an included file still takes precedence.

**Glob patterns** (e.g. `**/*.yaml`, `routes/*.yaml`) are expanded at load time against the module directory. At publish time, globs are expanded and partial file contents are inlined into the published artifact, so registry consumers receive a single self-contained manifest.

**IDE support:** When a partial file is opened directly in an IDE, the analyzer walks parent directories to find the owning `telo.yaml` and provides full diagnostics in context. If a file has a discoverable owner but is not listed in its `include` field, a warning is shown indicating the file will not be loaded at runtime.

---

## 3. Resource Association and Namespaces

Resources (such as HTTP APIs, worker scripts, or message queues) are isolated within namespaces dictated by their module. The `metadata.module` property establishes this relationship.

- **The Golden Rule of Identifiers**: Resource names (`metadata.name`) and Import aliases **must not contain hyphens (`-`)**. This is a technical engine constraint; hyphens in CEL are treated as subtraction operators. All names must match `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- **Explicit Binding**: Setting `metadata.module: <module-slug>` (kebab-case) binds the resource to that specific module's namespace.
- **Implicit Binding (Default Namespace)**: If the `metadata.module` property is omitted, the Telo engine automatically assigns the resource to `module: default`.
- **Recommended Styles**:
- **PascalCase** for Resource Types (`kind`), e.g., `Http.Api`.
- **PascalCase** for Instances (Resources & Imports), e.g., `UserApi`.

### 3.1 Referencing Resources

Resources interact via the target's `name` and `kind`.

- **Local Reference**: If the target resides in the same module, the `module` property is omitted in the reference.
- **External Reference**: If the target resides in a different module, the `module` property must be explicitly defined using the target module's slug.

---

## 4. Definition Example

This example demonstrates an application module requiring a connection string and an optional payment key. It exposes a health URL and the API instance itself.

### Module File (The Contract)

```yaml
kind: Kernel.Library
metadata:
  name: user-service
  version: 1.0.0

variables:
  dbConnectionString:
    type: string
  enableDebug:
    type: boolean
    default: null

secrets:
  paymentProviderKey:
    type: string
    default: null
```

### Internal Resource Files (The Implementation)

```yaml
kind: Http.Api
metadata:
  name: UserApi
  module: user-service
routes:
  # Local Reference
  - request:
      path: /users
      method: GET
    handler:
      kind: User.Repository
      name: UserRepository

  - request:
      path: /users/{id}
      method: GET
    handler:
      kind: User.Repository
      name: UserRepository

  # External Reference using the module slug
  - request:
      path: /users/{id}/orders
      method: GET
    handler:
      kind: Order.Repository
      name: OrderRepository
      module: order-service
---
kind: User.Repository
metadata:
  name: UserRepository
  module: user-service
inputs:
  connectionString: "${{ variables.dbConnectionString }}"
  debug: "${{ variables.enableDebug }}"
```

---

## 5. Root Module (Application)

The root of every running instance is a `Kernel.Application`. It is the only module bootstrapped directly by the Telo runtime (e.g., via a CLI target or deployment configuration) and the **only** module that has access to the host's environment variables via the `env` object. `Kernel.Library` manifests cannot be roots — attempting to `loadFromConfig` on a Library is a hard error.

### 5.1 The `env` Capability

The `env` object represents the host process's environment variables and is **exclusively available** in the root Application. Imported libraries are deliberately isolated from the host environment — they can only receive values explicitly passed through their declared `variables` and `secrets` contract. This is a core security boundary of the module system.

- **Available in**: The root `Kernel.Application` and any `Kernel.Import` declared in its files.
- **Unavailable in**: Any imported `Kernel.Library`, regardless of nesting depth.
- **Usage**: `${{ env.VARIABLE_NAME }}` in any CEL expression within the root Application.

### 5.2 Designating a Root Module

The root is always the `Kernel.Application` named on the CLI or by the deployment target. Only Applications can serve this role; Libraries cannot. A module graph has exactly one root per running instance.

### 5.3 Example

The primary purpose of the root Application is to bridge the host environment to its imported libraries' contracts, keeping secrets out of library files entirely.

```yaml
# main.yaml (The Root Application)
kind: Kernel.Application
metadata:
  name: backend-root
  version: 1.0.0

---
# The root module imports the payment gateway and injects host environment
# variables into the child module's explicit contract.
kind: Kernel.Import
metadata:
  name: PaymentGateway
source: acme/payment-gateway@1.2.0
variables:
  upstreamProviderUrl: "https://api.stripe.com"
  retryTimeoutMs: 5000
secrets:
  # The 'env' capability is available here because this is the root module.
  # It securely maps host environment variables to the child's secret contract.
  providerApiKey: "${{ env.STRIPE_SECRET_KEY }}"
  webhookSignature: "${{ env.STRIPE_WEBHOOK_SECRET }}"

---
kind: Kernel.Import
metadata:
  name: UserService
source: acme/user-service@1.0.0
variables:
  dbConnectionString: "${{ env.DATABASE_URL }}"
```

The child modules (`acme/payment-gateway`, `acme/user-service`) never declare or reference `env`. They only declare their inputs as typed `variables` and `secrets`, keeping them fully portable and environment-agnostic.

---

## 6. Import and Usage (`kind: Kernel.Import`)

To utilize an external package, a project declares a dependency using `kind: Kernel.Import`. The import acts as a local proxy.

- **Instantiation**: The `Import` resource provides the required `variables` and `secrets`.
- **Referencing**: Once imported, the module's snapshot is stored under `resources.<ImportName>` alongside local resources. Access exported properties directly.
- **Syntax**: `${{ resources.<ImportName>.<exportProperty> }}`.

### 6.1 Source Resolution

The `source` field accepts three forms:

| Form               | Example                                   | Resolved as                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------- |
| Registry reference | `acme/user-service@1.0.0`                 | Looked up in the configured module registry       |
| Relative path      | `./payment/telo.yaml`                   | Resolved relative to the importing manifest's URL |
| Absolute URL       | `https://cdn.example.com/lib/telo.yaml` | Fetched directly                                  |

Relative paths follow the same semantics as `<script src>` in HTML — the base URL is always the manifest that contains the `Kernel.Import`, not the current working directory. This means a manifest fetched from a remote URL can itself import other remote modules using relative paths.

### Import Declaration

```yaml
kind: Kernel.Import
metadata:
  name: UserService
  # Implicitly module: default
source: acme/user-service@1.0.0
variables:
  dbConnectionString: "postgresql://app_user:pass@db.internal:5432/users"
  enableDebug: true
secrets:
  paymentProviderKey: "sk_live_12345"
```
