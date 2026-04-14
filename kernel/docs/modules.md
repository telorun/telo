# Telo Module Specification (v1.0 Draft)

## Overview

A Telo Module is a self-contained, encapsulated package of application logic, services, or system components. It enforces a logical boundary between its internal implementation details (resources) and its public interface. This specification defines how modules declare their inputs, manage internal state, and expose specific capabilities to external consumers.

---

## 1. Module Contract (`kind: Kernel.Module`)

The `Kernel.Module` kind acts as the manifest and public interface for the package. It is the single source of truth for what the module needs to run and what it provides to the outside world. It utilizes JSON Schema validation for its inputs and Common Expression Language (CEL) for its outputs.

- **`metadata.name`**: This serves as the global identifier in the package registry. It should be a **kebab-case slug** (e.g., `user-service`) to remain URL-friendly and consistent with standard registry patterns.
- **`variables`**: Defines the standard configuration properties required by the module. These are defined as **JSON Schema object properties**. Per the style guide, these should use **camelCase** (e.g., `dbConnectionString`).
- **`secrets`**: Defines sensitive inputs. These are also defined as **JSON Schema object properties** but are handled separately to ensure secure injection and to prevent accidental exposure in logs.
- **Optionality (No `required` block)**: Requirement validation is handled via defaults. If an input is mandatory, it is defined without a `default`. If it is optional, it must be explicitly defined with `default: null`.
- **`exports`**: Declares which resource kinds this module exposes to consumers. Kinds listed here become accessible to importers under the import alias.

---

## 2. Including External Manifests

A module can load additional manifests from other files into the same module scope using the `include` field. This allows splitting a large module definition across multiple files while keeping them logically united under one module.

```yaml
kind: Kernel.Module
metadata:
  name: user-service
  version: 1.0.0

variables:
  dbConnectionString:
    type: string

exports:
  kinds:
    - UserApi
```

All resources defined in included files behave as if they were declared in the same file — they share the same module namespace and have access to the same `variables`, `secrets`, and `resources` context. Included files must not redeclare a `kind: Kernel.Module` manifest.

Resources in included files that omit `metadata.module` are automatically bound to the including module, rather than the `default` module. Explicitly setting `metadata.module` on a resource in an included file still takes precedence.

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
kind: Kernel.Module
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

## 5. Root Module

A **Root Module** is the designated entry point of an application. It is the only module in the dependency graph that is bootstrapped directly by the Telo runtime (e.g., via a CLI target or deployment configuration), and it is the **only** module that has access to the host's environment variables via the `env` object.

### 5.1 The `env` Capability

The `env` object represents the host process's environment variables and is **exclusively available** in Root Module documents. Child modules are deliberately isolated from the host environment — they can only receive values that are explicitly passed through their declared `variables` and `secrets` contract. This is a core security boundary of the module system.

- **Available in**: Root Module documents only (`kind: Kernel.Module` and `kind: Kernel.Import` declared in the root module's files).
- **Unavailable in**: Any non-root module, regardless of nesting depth.
- **Usage**: `${{ env.VARIABLE_NAME }}` in any CEL expression within the root module.

### 5.2 Designating a Root Module

A module is designated as the root externally — by the deployment target, CLI invocation, or platform configuration — not by a flag inside the YAML itself. Any module can serve as a root, but a module graph can only have one root entry point per running instance.

### 5.3 Example

The primary purpose of the Root Module is to bridge the host environment to its child modules' contracts, keeping secrets out of child module files entirely.

```yaml
# main.yaml (The Root Module)
kind: Kernel.Module
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
- **Referencing**: Once imported, the module's exported properties are accessed directly through the import instance name. The `.exports` accessor is omitted for cleaner syntax.
- **Syntax**: `${{ imports.<ImportName>.<exportProperty> }}`.

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
