---
description: "Telo: YAML-driven execution engine for declarative backends with micro-kernel architecture and language-agnostic design"
---

# ⚡ Telo

Runtime for declarative backends.

Telo is an execution engine (Micro-Kernel) that runs logic defined entirely in YAML manifests. Instead of writing imperative backend code, you define your routes, databases, schemas, and AI workflows as atomic, interconnected YAML documents. Telo takes those manifests and runs them.

Built to be language-agnostic and infinitely extensible.

```bash
# Reconcile your manifest into a running backend
$ telo ./examples/hello-api.yaml

{"level":30,"time":1771610393008,"pid":1310178,"hostname":"dev","msg":"Server listening at http://127.0.0.1:8844"}
```

## Why use Telo?

- **Open Standards:** Built on YAML, JSON Schema, and CEL — no proprietary DSL.
- **Static Analysis:** CEL type checking, reference validation, and IDE diagnostics catch errors before runtime.
- **Micro-Kernel Architecture:** Telo itself knows nothing about HTTP or SQL. Everything is a module you import, scope, and compose with typed variable and secret contracts.
- **Language Agnostic:** Available as a Node.js runtime today, with a shared YAML runtime contract that allows for future Rust or Go implementations without changing your manifests.

## What It Does

- **Loads** YAML resources and compiles CEL expressions (`${{ }}`) into an in-memory registry.
- **Resolves** resource dependencies via a multi-pass init loop, handling ordering automatically.
- **Indexes** resources by Kind and Name for constant-time lookup.
- **Dispatches** execution to the controller that owns each Kind.

Manifests also support directives for dynamic generation: `$let`, `$if`, `$for`, `$eval`, and `$include`. See [CEL-YAML Templating](./yaml-cel-templating/README.md) for documentation.

## Example manifest

Here is an example Telo application that defines a simple HTTP API:

```yaml
kind: Telo.Application
metadata:
  name: feedback
  version: 1.0.0
  description: |
    A complete feedback collection REST API — no code, pure YAML.
    Persists entries to SQLite and serves them over HTTP.
targets:
  - Migrations
  - Server
---
kind: Telo.Import
metadata:
  name: Http
source: ../modules/http-server
---
kind: Telo.Import
metadata:
  name: Sql
source: ../modules/sql
---
# SQLite database — swap driver/host/database for PostgreSQL with zero YAML changes
kind: Sql.Connection
metadata:
  name: Db
driver: sqlite
file: ./tmp/feedback.db
---
# Migrations: applied automatically before the server starts
kind: Sql.Migrations
metadata:
  name: Migrations
connection:
  kind: Sql.Connection
  name: Db
---
kind: Sql.Migration
metadata:
  name: Migration_20260413_182154_CreateFeedback
version: 20260413_182154_CreateFeedback
sql: |
  CREATE TABLE IF NOT EXISTS feedback (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    text      TEXT    NOT NULL,
    source    TEXT,
    score     INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
---
kind: Http.Server
metadata:
  name: Server
baseUrl: http://localhost:8844
port: 8844
logger: true
openapi:
  info:
    title: Feedback API
    version: 1.0.0
mounts:
  - path: /v1
    type: Http.Api.FeedbackRoutes
---
kind: Http.Api
metadata:
  name: FeedbackRoutes
routes:
  # POST /v1/feedback — insert a new entry, score derived from body length heuristic
  - request:
      path: /feedback
      method: POST
      schema:
        body:
          type: object
          properties:
            text:
              type: string
              minLength: 1
            source:
              type: string
          required: [text]
    handler:
      kind: Sql.Exec
      connection:
        kind: Sql.Connection
        name: Db
    inputs:
      sql: "INSERT INTO feedback (text, source, score) VALUES (?, ?, ?)"
      bindings:
        - "${{ request.body.text }}"
        - "${{ request.body.source }}"
        - "${{ size(request.body.text) }}"
    response:
      - status: 201
        headers:
          Content-Type: application/json
        body:
          ok: true
          message: Feedback received

  # GET /v1/feedback — list all entries, newest first
  - request:
      path: /feedback
      method: GET
    handler:
      kind: Sql.Select
      connection:
        kind: Sql.Connection
        name: Db
      from: feedback
      columns: [id, text, source, score, created_at]
      orderBy:
        - { column: created_at, direction: desc }
    response:
      - status: 200
        headers:
          Content-Type: application/json
        body: "${{ result.rows }}"

  # GET /v1/feedback/{id} — fetch a single entry
  - request:
      path: /feedback/{id}
      method: GET
      schema:
        params:
          type: object
          properties:
            id:
              type: integer
          required: [id]
    handler:
      kind: Sql.Select
      connection:
        kind: Sql.Connection
        name: Db
      from: feedback
      columns: [id, text, source, score, created_at]
      where:
        - { column: id, op: "=", value: "${{ request.params.id }}" }
    response:
      - status: 200
        when: "size(result.rows) > 0"
        headers:
          Content-Type: application/json
        body: "${{ result.rows[0] }}"
      - status: 404
        headers:
          Content-Type: application/json
        body:
          ok: false
          message: Not found
```

## Status

Telo is under **active development**. The core runtime, module system, and standard library are functional, but the API surface — including YAML shapes — may change without notice. Not yet recommended for production use.

## The Meaning of Telo

The name Telo is derived from the Greek root Telos - meaning the "end goal", "purpose", or "final state". That is exactly the philosophy behind this runtime. In standard imperative programming, you have to write thousands of lines of code to tell a server exactly how to start. With Telo, you simply declare your desired final state.

You define the end state. Telo makes it real.

## Philosophy

Modern platforms often spend disproportionate effort on technical mechanics-wiring frameworks, managing infrastructure, and negotiating toolchains-while the original business problem gets delayed or diluted. Telo pushes in the opposite direction: it treats kernel execution as a stable, predictable host so teams can concentrate on the **business logic and outcomes** instead of the plumbing.

By separating "what the system should do" from "how it is hosted", the runtime reduces friction for domain‑level changes. Teams can move faster on product requirements, experiment more safely, and keep conversations centered on value delivered rather than implementation trivia.

Telo also aims to **join forces across all programming language communities**, so the best ideas, patterns, and implementations can converge into a shared kernel truth without forcing everyone into a single stack.

YAML also makes the system more **AI‑friendly** than traditional programming languages: it is explicit, structured, and easier for tools to generate, review, and transform without losing intent.

## Modularity

Telo is built around **modules** that own specific resource kinds. A module is loaded from a manifest, declares which kinds it implements, and then receives only the resources of those kinds. This keeps concerns isolated and lets teams compose systems from focused building blocks rather than monolithic services.

At kernel execution time, execution is always routed by **Kind.Name**. The kernel resolves the Kind to its owning module and hands off execution. Modules can call back into the kernel to execute other resources, enabling composition without tight coupling.

## Architecture

The architecture is inspired by Kubernetes-style manifests: declarative resources, explicit kinds, and a control plane that routes work based on those definitions.
Those manifests were taken to the next level by allowing them to run inside a standalone runtime host.

## See more at

- [Telo Kernel](./kernel/README.md)
- [CEL-YAML Templating](./yaml-cel-templating/README.md)
- [Telo SDK for module authors](sdk/README.md)
- [Modules](modules/README.md)

## License

See [LICENSE](https://github.com/telorun/telo/blob/main/LICENSE).

## Contribution Note

By contributing, you agree that code and examples in this repository may be translated or re‑implemented in other programming languages (including by AI systems) to support the project’s polyglot goals.
