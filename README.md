# ⚡ Telo

Runtime for declarative backends.

Telo is an execution engine (Micro-Kernel) that runs logic defined entirely in YAML manifests. Instead of writing imperative backend code, you define your routes, databases, schemas, and AI workflows as atomic, interconnected YAML documents. Telo takes those manifests and runs them.

Built to be language-agnostic and infinitely extensible,.

🔮 The Meaning of Telo

The name Telo is derived from the Greek root Telos - meaning the "end goal", "purpose", or "final state". That is exactly the philosophy behind this runtime. In standard imperative programming, you have to write thousands of lines of code to tell a server exactly how to start. With Telo, you simply declare your desired final state.

You define the end state. Telo makes it real.

```bash
# Reconcile your manifest into a running backend
$ telo https://raw.githubusercontent.com/diglyai/telo/refs/heads/main/examples/hello-api/module.yaml

{"level":30,"time":1771610393008,"pid":1310178,"hostname":"dev","msg":"Server listening at http://127.0.0.1:8844"}
```

## Why use Telo?

Zero Lock-in: Your entire backend is just standard YAML, JSON Schema and CEL expressions.

Micro-Kernel Architecture: Telo itself knows nothing about HTTP or SQL. Everything is a plugin (module), meaning you only load exactly what you need.

Language Agnostic: Available as a Node.js runtime today, with a shared YAML runtime contract that allows for future Rust or Go implementations without changing your manifests.

## Example manifest

Here is an example Telo application that defines a simple HTTP API:

```yaml
kind: Runtime.Module
metadata:
  name: Example
imports:
  - std/http-server@1.0.1
  - std/javascript@1.0.0
---
kind: Http.Server
metadata:
  name: Example
  module: Example
baseUrl: http://localhost:8844
port: 8844
logger: true
openapi:
  info:
    title: Hello server
    version: 1.0.0
mounts:
  - path: /v1
    type: Http.Api.HelloApi
---
kind: Http.Api
metadata:
  name: HelloApi
  module: Example
routes:
  - request:
      path: /hello
      method: GET
      schema:
        query:
          type: object
          properties:
            name:
              type: string
          required: ["name"]
    handler:
      kind: JavaScript.Script
      name: SayHello
      inputs:
        name: "${{ request.query.name }}" # CEL expression
    response:
      status: 200
      statuses:
        "200":
          schema:
            body:
              type: object
              properties:
                greeting:
                  type: string
                nice:
                  type: string
              required: ["greeting", "nice"]
              additionalProperties: false
          headers:
            Content-Type: application/json
          body:
            greeting: "${{ result.message }}!"
            nice: "WOW"
---
kind: JavaScript.Script
metadata:
  name: SayHello
  module: Example
code: |
  function main({ name }) {
    return {
      message: `Hello ${name}!`,
    }
  };
inputSchema:
  name:
    type: string
outputSchema:
  message:
    type: string
```

## What It Does

- **Loads** resolved YAML resources into an immutable in‑memory registry.
- **Expands** TemplateDefinitions to dynamically generate resources with loops and conditionals.
- **Indexes** resources by Kind and Name for constant‑time lookup.
- **Dispatches** execution requests to the module that owns a Kind.

### Built-in Template System

The runtime includes a powerful template system for generating resources dynamically:

```yaml
# Define a template
kind: TemplateDefinition
metadata:
  name: ApiServer
schema:
  type: object
  properties:
    regions: { type: array, default: ['us-east', 'eu-west'] }
resources:
  - for: "region in regions"
    kind: Http.Server
    metadata:
      name: "api-${{ region }}"
    region: "${{ region }}"

# Instantiate it
kind: Template.ApiServer
metadata:
  name: ProductionApi
regions: ['us-east-1', 'us-west-2', 'eu-central-1']
```

See [TEMPLATES.md](./yaml-cel-templating/README.md) for comprehensive documentation.

## Status

This repository is an **early prototype** of the Telo runtime and specs. It is intended for exploration, feedback, and shaping the architecture rather than production use. The API surface - including YAML shapes - may change at any time without notice.

## Why

Modern platforms often spend disproportionate effort on technical mechanics-wiring frameworks, managing infrastructure, and negotiating toolchains-while the original business problem gets delayed or diluted. Telo pushes in the opposite direction: it treats kernel execution as a stable, predictable host so teams can concentrate on the **business logic and outcomes** instead of the plumbing.

By separating "what the system should do" from "how it is hosted", the runtime reduces friction for domain‑level changes. Teams can move faster on product requirements, experiment more safely, and keep conversations centered on value delivered rather than implementation trivia.

Telo also aims to **join forces across all programming language communities**, so the best ideas, patterns, and implementations can converge into a shared kernel truth without forcing everyone into a single stack.

YAML also makes the system more **AI‑friendly** than traditional programming languages: it is explicit, structured, and easier for tools to generate, review, and transform without losing intent.

## Modularity

Telo is built around **modules** that own specific resource kinds. A module is loaded from a manifest, declares which kinds it implements, and then receives only the resources of those kinds. This keeps concerns isolated and lets teams compose systems from focused building blocks rather than monolithic services.

At kernel execution time, execution is always routed by **Kind.Name**. The kernel resolves the Kind to its owning module and hands off execution. Modules can call back into the kernel to execute other resources, enabling composition without tight coupling.

## Architecture

The architecture is inspired by Kubernetes-style manifests: declarative resources, explicit kinds, and a control plane that routes work based on those definitions.
Those manifest were taken to the next level by allowing them to run inside a standalone runtime host.

## Kernel Details

Implementation details, loading rules, and the kernel manifest specification live in `kernel/README.md`.

## See more at

- [Telo Kernel](./kernel/README.md)
- [Template System](./yaml-cel-templating/README.md)
- [Telo SDK for module authors](sdk/README.md)
- [Modules](modules/README.md)
  - [HttpServer](modules/http-server/README.md)

## License

See [LICENSE](https://github.com/diglyai/telo/blob/main/LICENSE).

## Contribution Note

By contributing, you agree that code and examples in this repository may be translated or re‑implemented in other programming languages (including by AI systems) to support the project’s polyglot goals.
