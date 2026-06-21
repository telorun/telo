<p align="center">
  <img src="https://raw.githubusercontent.com/telorun/telo/main/assets/telo.png" alt="Telo" width="200" />
</p>

<h1 align="center">Telo</h1>

<p align="center">Runtime for declarative backends.</p>

<p align="center">
  <a href="https://github.com/telorun/telo/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/telorun/telo/actions/workflows/test.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@telorun/cli"><img alt="node" src="https://img.shields.io/node/v/@telorun/cli" /></a>
  <br />
  <a href="https://github.com/telorun/telo/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/telorun/telo" /></a>
  <a href="https://github.com/telorun/telo/issues"><img alt="Issues" src="https://img.shields.io/github/issues/telorun/telo" /></a>
  <a href="https://github.com/telorun/telo/pulls"><img alt="Pull requests" src="https://img.shields.io/github/issues-pr/telorun/telo" /></a>
  <br />
  <img alt="Changesets" src="https://img.shields.io/badge/maintained%20with-changesets-176de3" />
</p>

Telo is an execution engine (Micro-Kernel) that runs logic defined entirely in YAML manifests. Instead of writing imperative backend code, you define your routes, databases, schemas, and AI workflows as atomic, interconnected YAML documents. Telo takes those manifests and runs them.

Built to be language-agnostic and infinitely extensible.

```bash
# Reconcile your manifest into a running backend
$ telo ./examples/hello-api

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

## Example manifest

See [examples/](./examples/) for a list of working applications.

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
- [Telo SDK for module authors](sdk/README.md)
- [Modules](modules/README.md)

## License

See [LICENSE](https://github.com/telorun/telo/blob/main/LICENSE).

## Contribution Note

By contributing, you agree that code and examples in this repository may be translated or re‑implemented in other programming languages (including by AI systems) to support the project’s polyglot goals.
