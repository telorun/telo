# Telo Module Specification (v1.0 Draft)

## Overview

A Telo Module is a self-contained, encapsulated package of application logic, services, or system components. It enforces a logical boundary between its internal implementation details (resources) and its public interface. This specification defines how modules declare their inputs, manage internal state, and expose specific capabilities to external consumers.

---

## 1. Module Contract (`kind: Module`)

The `Module` kind acts as the manifest and public interface for the package. It is the single source of truth for what the module needs to run and what it provides to the outside world. It utilizes JSON Schema validation for its inputs and Common Expression Language (CEL) for its outputs.

- **`metadata.name`**: This serves as the global identifier in the package registry. It should be a **kebab-case slug** (e.g., `user-service`) to remain URL-friendly and consistent with standard registry patterns.
- **`variables`**: Defines the standard configuration properties required by the module. These are defined as **JSON Schema object properties**. Per the style guide, these should use **camelCase** (e.g., `dbConnectionString`).
- **`secrets`**: Defines sensitive inputs. These are also defined as **JSON Schema object properties** but are handled separately to ensure secure injection and to prevent accidental exposure in logs.
- **Optionality (No `required` block)**: Requirement validation is handled via defaults. If an input is mandatory, it is defined without a `default`. If it is optional, it must be explicitly defined with `default: null`.
- **`exports`**: A dictionary defining the module's public API. Internal resources are private by default. To expose them, they must be mapped using CEL expressions (`${{ ... }}`). Exports should use **camelCase** for consistency with property access.

---

## 2. Resource Association and Namespaces

Resources (such as HTTP APIs, worker scripts, or message queues) are isolated within namespaces dictated by their module. The `metadata.module` property establishes this relationship.

- **The Golden Rule of Identifiers**: Resource names (`metadata.name`) and Import aliases **must not contain hyphens (`-`)**. This is a technical engine constraint; hyphens in CEL are treated as subtraction operators. All names must match `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- **Explicit Binding**: Setting `metadata.module: <module-slug>` (kebab-case) binds the resource to that specific module's namespace.
- **Implicit Binding (Default Namespace)**: If the `metadata.module` property is omitted, the Telo engine automatically assigns the resource to `module: default`.
- **Recommended Styles**:
- **PascalCase** for Resource Types (`kind`), e.g., `Http.Api`.
- **PascalCase** for Instances (Resources & Imports), e.g., `UserApi`.

### 2.1 Referencing Resources

Resources interact via the target's `name` and `kind`.

- **Local Reference**: If the target resides in the same module, the `module` property is omitted in the reference.
- **External Reference**: If the target resides in a different module, the `module` property must be explicitly defined using the target module's slug.

---

## 3. Definition Example

This example demonstrates an application module requiring a connection string and an optional payment key. It exposes a health URL and the API instance itself.

### Module File (The Contract)

```yaml
kind: Module
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

exports:
  # camelCase for exported properties
  healthEndpoint: "${{ resources.UserApi.url }}/health"
  apiInstance: "${{ resources.UserApi }}"
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

## 4. Import and Usage (`kind: Import`)

To utilize an external package, a project declares a dependency using `kind: Import`. The import acts as a local proxy.

- **Instantiation**: The `Import` resource provides the required `variables` and `secrets`.
- **Referencing**: Once imported, the module's exported properties are accessed directly through the import instance name. The `.exports` accessor is omitted for cleaner syntax.
- **Syntax**: `${{ imports.<ImportName>.<exportProperty> }}`.

### Import Declaration

```yaml
kind: Import
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

### Export Usage in Local Resources

```yaml
kind: Order.Service
metadata:
  name: OrderProcessor
inputs:
  # Binding to the exported resource directly
  userServiceRef: "${{ imports.UserService.apiInstance }}"
```
