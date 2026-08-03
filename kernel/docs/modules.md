---
description: "v1.0 spec for modules: Telo.Application and Telo.Library contracts with inputs, exports, and external manifest inclusion"
---

# Telo Module Specification (v1.0 Draft)

## Overview

A Telo Module is a self-contained, encapsulated package of application logic, services, or system components. It enforces a logical boundary between its internal implementation details (resources) and its public interface. This specification defines how modules declare their inputs, manage internal state, and expose specific capabilities to external consumers.

---

## 1. Module Contract (`kind: Telo.Application` / `kind: Telo.Library`)

Every module file begins with exactly one `Telo.Application` or `Telo.Library` document — the manifest and public interface for the package. Applications are runnable entry points; Libraries are units imported by others. Both use JSON Schema validation for their inputs.

- **`metadata.name`**: Global identifier in the package registry. Kebab-case slug (e.g., `user-service`) to remain URL-friendly and consistent with standard registry patterns.
- **`variables`**: Standard configuration properties required by the module. JSON Schema object properties. Per the style guide, use **camelCase** (e.g., `dbConnectionString`).
- **`secrets`**: Sensitive inputs. Also JSON Schema object properties, handled separately to ensure secure injection and prevent accidental exposure in logs.
- **Optionality (No `required` block)**: Requirement validation is handled via defaults. Mandatory inputs are defined without a `default`. Optional inputs must be explicitly defined with `default: null`.

**Application-only:**

- **`targets`**: Optional. Resources to run once initialization completes. Applications whose work is carried entirely by auto-start Services (e.g. an HTTP server) may declare no targets.
- **`lifecycle`**: Runtime lifecycle hint (`"shared"` (default) | `"isolated"`).
- Binds host environment variables (via `env:` keys on its `variables:`/`secrets:`/`ports:` entries) when loaded as the root manifest. Never valid as the target of an `imports:` entry.

**Library-only:**

- **`exports.kinds`**: Which resource kinds this library exposes to importers.
- `targets` and `lifecycle` are forbidden — libraries are not lifecycle participants.
- Never runnable via `loadFromConfig`; loaded only through an importer's `imports:` entry.

---

## 2. Including External Manifests

A module can load additional manifests from other files into the same module scope using the `include` field. This allows splitting a large module definition across multiple files while keeping them logically united under one module. Glob patterns are supported.

```yaml
kind: Telo.Library
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

- Must not contain `kind: Telo.Application`, `kind: Telo.Library`, `kind: Telo.Import`, or `kind: Telo.Definition`. These system kinds are reserved for the owner `telo.yaml`.
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
kind: Telo.Library
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

The root of every running instance is a `Telo.Application`. It is the only module bootstrapped directly by the Telo runtime (e.g., via a CLI target or deployment configuration) and the **only** module that can bind the host's environment variables — through `env:` keys on its `variables:` / `secrets:` / `ports:` entries. `Telo.Library` manifests cannot be roots — attempting to `loadFromConfig` on a Library is a hard error.

### 5.1 Host Environment Access

Host environment variables are reachable **only** by declaring a typed root entry bound to them. Each `variables:` / `secrets:` entry names a host variable via its `env:` key (and `ports:` entries do the same for inbound ports); the resolved value lands in the `variables.X` / `secrets.X` / `ports.X` CEL scope. There is no raw `env` map in CEL — a host variable that is not declared on the root is not reachable. Imported libraries are deliberately isolated from the host environment: they receive only the values explicitly passed through their declared `variables` and `secrets` contract. This is a core security boundary of the module system.

- **Bound by**: an `env:` key on a root `Telo.Application`'s `variables:` / `secrets:` / `ports:` entry, read as `${{ variables.X }}` / `${{ secrets.X }}` / `${{ ports.X }}`.
- **Unavailable in**: an `imports:` entry's `variables:`/`secrets:` — those are a **config-only contract** whose expressions see only the importing module's `variables`/`secrets` (never `resources` or `ports`) — and any imported `Telo.Library`, regardless of nesting depth.
- **Forwarding**: to pass an env-derived value into an import, bind it to a typed root `variables:`/`secrets:` entry and forward it as `${{ variables.X }}` / `${{ secrets.X }}`.

### 5.2 Designating a Root Module

The root is always the `Telo.Application` named on the CLI or by the deployment target. Only Applications can serve this role; Libraries cannot. A module graph has exactly one root per running instance.

### 5.3 Example

The primary purpose of the root Application is to bridge the host environment to its imported libraries' contracts, keeping secrets out of library files entirely. The root binds host env into its own typed `variables:`/`secrets:`, then forwards those into each import — an import input is a **config-only** expression that may reference only the importing module's `variables`/`secrets`.

```yaml
# main.yaml (The Root Application)
kind: Telo.Application
metadata:
  name: backend-root
  version: 1.0.0
# Host env is bound into the root's own typed contract...
secrets:
  stripeApiKey:
    env: STRIPE_SECRET_KEY
    type: string
  stripeWebhookSignature:
    env: STRIPE_WEBHOOK_SECRET
    type: string
variables:
  databaseUrl:
    env: DATABASE_URL
    type: string
imports:
  # ...then forwarded into each child's explicit contract. Import inputs reference
  # only the importing module's variables/secrets. Forwarding is eager and
  # per-hop, so a value flows app -> lib -> lib at any depth and resolves in O(1).
  PaymentGateway:
    source: acme/payment-gateway@1.2.0
    variables:
      upstreamProviderUrl: "https://api.stripe.com"
      retryTimeoutMs: 5000
    secrets:
      providerApiKey: "${{ secrets.stripeApiKey }}"
      webhookSignature: "${{ secrets.stripeWebhookSignature }}"
  UserService:
    source: acme/user-service@1.0.0
    variables:
      dbConnectionString: "${{ variables.databaseUrl }}"
```

The child modules (`acme/payment-gateway`, `acme/user-service`) never touch the host environment. They only declare their inputs as typed `variables` and `secrets`, keeping them fully portable and environment-agnostic.

---

## 6. Import and Usage (the `imports:` map)

To utilize an external package, a module declares a dependency as an entry in its `imports:` map — a name-keyed map placed on the `Telo.Application` / `Telo.Library` document directly after `metadata:`. Each key is the PascalCase alias the dependency is referenced by; each value is either a bare **source string** or an object carrying `source` plus optional `variables` / `secrets` / `runtime`.

- **Instantiation**: The entry provides the required `variables` and `secrets`.
- **Referencing**: Once imported, the module's snapshot is stored under `resources.<Alias>` alongside local resources. Access exported properties directly.
- **Syntax**: `${{ resources.<Alias>.<exportProperty> }}`.

### 6.1 Source Resolution

The `source` field accepts four forms:

| Form               | Example                                          | Resolved as                                       |
| ------------------ | ------------------------------------------------ | ------------------------------------------------- |
| OCI reference      | `oci://ghcr.io/telorun/console@0.15.0`           | Pulled from that OCI host                         |
| Registry reference | `acme/user-service@1.0.0`                        | Looked up in the configured module registry       |
| Relative path      | `./payment/telo.yaml`                            | Resolved relative to the importing manifest's URL |
| Absolute URL       | `https://cdn.example.com/lib/telo.yaml`          | Fetched directly                                  |

`oci://` is the form the standard library and every first-party module publish to; the bare `<namespace>/<name>@<version>` registry form is retained read-only so already-pinned manifests keep resolving.

Relative paths follow the same semantics as `<script src>` in HTML — the base URL is always the manifest that declares the `imports:` entry, not the current working directory. This means a manifest fetched from a remote URL can itself import other remote modules using relative paths.

### 6.2 Publishing locations

An OCI reference has the shape `oci://<host>/<path…>/<module-name>@<version>`. The path segments preceding the module name are the **publisher's** repository namespace on that host — `ghcr.io/telorun` for the Telo-curated standard library, `ghcr.io/acme` for a third party. Trust in a specific publisher is signalled out-of-band (a verification badge on the module's [hub](https://hub.telo.run) listing), not by the path string.

The standard library covers portable, vendor-neutral primitives whose surface is defined by an open protocol or by Telo itself: HTTP transport, SQL, JavaScript execution, config, sequencing, assertions, testing, console I/O. A module belongs there only if its semantics are not tied to any specific vendor implementation; Telo curates membership. Vendor adapters — `lambda`, `s3`, `cloud-functions` — are published the same way, under whichever repository their publisher owns.

Examples:

- `oci://ghcr.io/telorun/http-server`, `oci://ghcr.io/telorun/http-client` — HTTP is a public protocol; portable across vendors.
- `oci://ghcr.io/telorun/sql` — generic SQL surface area; specific DB drivers are separate modules (`sql-postgres`, `sql-sqlite`).
- `oci://ghcr.io/telorun/lambda` — vendor-defined APIs and event shapes, adapted by a Telo-authored module.

Where a module is published is a property of the **ref**, not of the library: a module declares nothing about its own location, and the same bytes can be published to an OCI repo, a registry path, or a URL without changing. Moving a module to a different repository is a breaking change to every consumer's `source:` field and is treated as a new module, not a version bump.

**Discovery.** Modules are discovered through the **hub** ([`hub.telo.run`](https://hub.telo.run)) — a federated index over every registered module across transports (the HTTP registry, OCI, and direct manifest URLs). `telo search "<query>"` and the hub's MCP tools (`search_resources`, `get_module_manifest` — see [Coding Agents](/build/coding-agents)) resolve intent to the exact kind and its owning ref. Discovery is independent of where a module is hosted: the hub stores only metadata and cached manifests, and `telo install` / `telo run` resolve the actual artifact against the module's own origin (see §7).

### Import Declaration

```yaml
kind: Telo.Application
metadata:
  name: backend-root
  version: 1.0.0
imports:
  UserService:
    source: acme/user-service@1.0.0
    variables:
      dbConnectionString: "postgresql://app_user:pass@db.internal:5432/users"
      enableDebug: true
    secrets:
      paymentProviderKey: "sk_live_12345"
```

A dependency that needs no `variables` / `secrets` / `runtime` can use the bare source-string shorthand:

```yaml
imports:
  Console: oci://ghcr.io/telorun/console@<version>
```

## 7. Manifest Cache

Resolution is separate from discovery: the [hub](#62-publishing-locations) indexes *what* modules exist, but the bytes of each `Telo.Library` are fetched from the module's own origin. A bare `<namespace>/<name>@<version>` ref resolves against the read-only registry origin (`registry.telo.run`), an `oci://…` ref against its OCI host, and an `https://…` ref directly. `telo install` walks the full import graph from a manifest, fetches every transitively-imported `Telo.Library` from its origin, and writes its YAML to a sibling of the controller install tree. Boot then resolves every import from disk and makes zero network calls — the cache is the single trust boundary that pins which manifests the runtime will see.

### Layout

```text
<entry-manifest-dir>/.telo/manifests/
  registry/<host>/<path…>/<version>/telo.yaml   # registry refs (source: ns/name@x.y.z)
  registry/<host>/<path…>/<version>/<partial>   # any include: target reachable from above
  oci/<host>/<repo…>/<tag>/telo.yaml            # OCI imports (source: oci://host/repo@tag)
  url/<host>/<pathname>                         # direct URL imports (source: https://…)
```

- Every entry is keyed `<transport>/<host>/<path…>/<version>/<file>` — the same grammar the hub's static manifest bucket and the editor's browser-safe read path use, so no two of them can drift on where a module lands. The coordinates come from the transport that owns the ref; `manifestCacheKey` in `@telorun/analyzer` renders them.
- Registry entries carry the **registry host**: a bare ref says nothing about which registry serves it, so without the host two registries' copies of the same path and version would share one cache entry.
- Direct URL imports carry no version segment. A URL addresses exactly one file, and the version it declares lives inside bytes the cache maps paths without.
- An HTTP URL whose host matches the configured registry URL is folded into the registry layout — `source: https://registry.telo.run/acme/foo/1.0.0/telo.yaml` and `source: acme/foo@1.0.0` hit the same cache file.
- URLs with a query string or fragment get a short content-hash inserted before the file extension so two distinct manifests differing only in query never collide.
- Partials reached through `include:` are written alongside their owning manifest using the same relative paths declared in the owner, so the loader's existing relative-resolution path keeps working unchanged once the owner is served from disk.

### Wiring

A `LocalManifestCacheSource` registered ahead of the network sources claims any URL that matches a populated cache file. The chain on a typical CLI invocation:

1. `LocalFileSource` — `file://`, absolute, or relative paths (the entry manifest, plus any `include:` and partials of cache-served files).
2. `LocalManifestCacheSource` — registry refs and HTTP URLs that have a corresponding file under `.telo/manifests/`.
3. `HttpSource` / `RegistrySource` — built-in fallbacks. Hit on cache miss, allowing dev runs without `telo install` to work unchanged.

The cache miss is silent: a missing file falls through to whichever network source claims the URL, exactly as if the cache layer weren't there. This is what keeps `telo install` optional for development and load-bearing only for hermetic deploys.

### Provenance

The cache is **content-addressed by URL**, not by content hash. `telo install` overwrites existing files with freshly fetched bytes on every run, so re-installing converges on whatever the registry currently serves for the pinned version. The trust model assumes versions are immutable in the registry; mutating a published version after install will silently shadow stale bytes until `telo install` runs again.

The cache is never pruned automatically. Stale entries — for versions no longer referenced by the manifest — stay until `.telo/manifests/` is removed by hand. This matches the `.telo/npm/` convention and keeps re-installs fast.

### Portability

`<entry-manifest-dir>/.telo/` is one self-contained tree. Containerised deploys typically `COPY` the manifest directory into the image and inherit both caches with no further work — the build stage runs `telo install`, the production stage is a single `COPY --from=build`, and boot does no network I/O.
