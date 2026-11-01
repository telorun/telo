<p align="center">
  <img src="assets/telo.svg" alt="Telo" width="120" />
</p>

<h1 align="center">Telo</h1>

<p align="center">Runtime for declarative applications — backend services and the data screens on top of them.</p>

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

Telo runs applications described in YAML files instead of written as program code. You declare your web APIs, databases, data screens (tables, forms, create/edit/delete) and AI workflows as small, connected YAML documents, and Telo checks them and runs them. There is no drag-and-drop screen builder: screens are declared in YAML like everything else.

Today you extend Telo in TypeScript (Rust for some native modules); the runtime is designed so other languages can be added.

**Where Telo is today:** the core runtime, module system, standard library and checker work, but Telo is pre-1.0 and not yet recommended for production use. See [Status](#status).

Deciding whether Telo fits your team? Start with [Compared to low-code platforms](https://telo.run/learn/vs-low-code), [Licensing](https://telo.run/learn/licensing) and the [examples](./examples/INDEX.md).

```bash
# Reconcile your manifest into a running application
$ telo ./examples/todo-app

{"time":"2026-11-01T10:29:16.386Z","level":"INFO","severity":9,"msg":"Listening","resource":{"kind":"HttpServer.Server","name":"server","id":"HttpServer.Server.server"},"attributes":{"server.address":"0.0.0.0","server.port":8077,"url.scheme":"http"},"event_name":"http.server.started"}
```

(On a terminal the same record prints human-readable and coloured.)

## Get started

Install the CLI — a single executable that carries its own runtime:

```bash
curl -fsSL https://telo.sh/install.sh | sh
```

On Windows, `irm https://telo.sh/install.ps1 | iex`. With Node.js already installed, `npm install -g @telorun/cli` gives the same `telo`.

Then follow [**Getting Started**](https://telo.run/learn/getting-started) on [telo.run](https://telo.run) — install, a first manifest, and what the kernel did with it — and [Your first HTTP API](https://telo.run/learn/first-http-api). Modules and their kinds are discoverable on the [hub](https://hub.telo.run).

## Why use Telo?

- **Open standards:** built on YAML, JSON Schema and CEL (a small expression language) — no proprietary language.
- **Mistakes caught before the app runs:** wrong references, wrong value types and missing inputs are reported with the exact place to fix, in the editor or in CI.
- **Everything is a module:** Telo itself knows nothing about HTTP or SQL. Each capability is a module you import and combine, with declared inputs and secrets.
- **Other runtimes are possible:** the runtime is Node.js today, with a shared YAML contract so other implementations can run the same manifests. A narrower Rust runtime exists and is in progress.

## What It Does

Telo reads your YAML files, checks them, works out what depends on what, starts everything in the right order, and hands each piece to the code that implements it. For the mechanics, see [How Telo works](https://telo.run/learn/how-telo-works).

## Example manifest

See [examples/](./examples/) for a list of working applications.

## Status

Telo is pre-1.0 on purpose. The core runtime, module system, standard library and checker work, but Telo is not yet recommended for production use. Breaking changes ship in **minor** releases: manifest shapes and module definitions can change between versions, so pin your imports and expect to update manifests when you upgrade (`telo migrate` rewrites old spellings for you).

**1.0 is planned for when the second, Rust-based runtime can run everything the Node.js one can** — that is the milestone that freezes the manifest format across runtimes.

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

The architecture is inspired by Kubernetes-style manifests: declarative resources, explicit kinds, and a runtime that routes work based on those definitions. Unlike Kubernetes, the manifests run inside one standalone process rather than describing a cluster.

## See more at

- [Telo Kernel](./kernel/README.md)
- [Telo SDK for module authors](sdk/README.md)
- [Modules](modules/README.md)

## License

In plain terms: Telo is free to use, including commercially. You can build, host and sell your own products on it. You cannot offer Telo itself to others as a managed service without a commercial licence from CodeNet Sp. z o.o. (contact@codenet.pl). The modules, SDK, examples and docs you build with are MIT. Details: [Licensing](https://telo.run/learn/licensing).

Two licenses, split by directory. Each MIT directory carries its own `LICENSE`; everything else falls under the root [LICENSE](https://github.com/telorun/telo/blob/main/LICENSE), the Sustainable Use License.

| MIT | Sustainable Use |
| --- | --- |
| `cel/`, `message-format/`, `sdk/`, `templating/`, `packages/glob/`, `packages/editor-protocol/` — the expression engine, the message core, the SDK and what a controller links against | `analyzer/`, `kernel/`, `cli/` — what loads, checks and runs a manifest |
| `modules/`, `blueprints/` — the standard library | `packages/ide-support/`, `packages/language-server/`, `packages/language-host/`, `ide/` — the editor tooling |
| `starters/`, `examples/`, `docs/`, `benchmarks/` | `packages/runner-core/`, `packages/debug-wire/`, `packages/debug-ui/`, `apps/docker-runner/`, `apps/k8s-runner/` — the runners |
| `apps/hub/`, `apps/hub-web/`, `apps/plan-approval*/` | `apps/studio/`, `apps/authoring-agent/`, `pages/` and everything not listed |

No MIT package depends on a Sustainable Use one, which `pnpm run check:licenses` enforces.

## Contribution Note

By contributing, you agree that code and examples in this repository may be translated or re‑implemented in other programming languages (including by AI systems) to support the project’s polyglot goals.
