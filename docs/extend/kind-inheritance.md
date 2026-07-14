---
sidebar_label: Kind Inheritance
slug: /extend/kind-inheritance
description: "Specialize any existing kind — abstract or concrete — with single inheritance. A child inherits the parent's controller, capability, and schema, and maps the parent's config through a base: construction mapping."
---

# Kind inheritance

A `Telo.Definition` can `extends` **any** kind — not only a `Telo.Abstract`, but a
**concrete kind** with a real controller. This is ordinary single inheritance:
the child reuses the parent's controller and behavior while presenting a
friendlier schema and preset config.

The motivating case: an API client that *is*, for every runtime and type purpose,
a preconfigured `std/http-client` `Client` — so it drops into anything that
expects a `Client`, and any operation that expects one can point at it.

## What a child inherits

A child that `extends` a concrete kind and declares **no** own `controllers:` /
template body inherits, by delegation:

- **The controller.** The kernel resolves the controller-bearing ancestor,
  evaluates the child's [`base:`](#base-the-super-mapping) mapping, calls the
  ancestor controller's `create()` with the mapped config, and **returns that
  instance verbatim**. The child instance therefore *is* a parent instance — it
  duck-types identically (e.g. it has the `Client`'s `.snapshot()`), so consumers
  and reference injection need no awareness of the subclass.
- **The capability — immutably.** Omit `capability` to inherit the ancestor's, or
  restate it identically. Declaring a *different* capability than an ancestor is a
  hard error (`EXTENDS_CAPABILITY_MISMATCH`). Inheritance never changes a kind's
  lifecycle role.
- **The schema.** With `base:` present, the child's author-facing schema is its
  **own** schema — the parent's config fields become internal, set solely through
  `base:`, so the child genuinely narrows. Without `base:`, the child's schema is
  `merge(parent, own)` — a pure additive extension exposing the parent's config
  fields plus its own.

A child is **Liskov-substitutable** for every ancestor at any `!ref` slot,
transitively — a `GithubClient` satisfies any slot typed
`x-telo-ref: "std/http-client#Client"`.

## `base:` — the super mapping

`base:` is the "`super(...)`" of Telo. It is a top-level sibling on the
definition: an object of CEL expressions over `self` (typed from the child's own
schema), evaluated once to build the config passed to the inherited controller.
It mirrors the existing `inputs:` / `result:` top-level-sibling factoring.

```yaml
kind: Telo.Definition
metadata: { name: GithubClient }
extends: Http.Client              # concrete parent; capability (Provider) inherited, immutable
schema:
  type: object
  required: [token]
  properties:
    token: { type: string }       # with base:, this IS the author surface
base:                             # the base kind's config, derived from self
  baseUrl: https://api.github.com
  headers:
    Authorization: !cel "'Bearer ' + self.token"
    Accept: application/vnd.github+json
```

`base:` constructs the parent's config **once**. How that config then *behaves* is
the parent controller's contract: fixed for kinds that consume config in
`create()` (like `Http.Client`), or baked defaults the controller re-layers per
call (like `Http.Request`, whose `inputs` a caller can still override).

> **Forwarding a reference field.** When `base:` forwards a reference the child
> holds (e.g. `client: !cel "self.client"`), write it as a **bare** `self.<field>`
> access — nothing more. By the time `base:` runs, that field is a **live resource
> instance**, and a live instance cannot flow through a CEL expression (CEL's type
> checker rejects it). So `!cel "self.enabled ? self.client : null"`,
> `!cel "[self.client]"`, or any wrapping of the reference will fail. Keep
> reference forwarding and value-building CEL in separate `base:` fields — the same
> rule that governs `self`-derived references in a templated `resources:` body.

## Worked example — a GitHub client library

A small library that exposes a `GithubClient` plus one wrapped operation:

```yaml
kind: Telo.Library
metadata:
  name: github
  namespace: acme
  version: 0.1.0
imports:
  Http: std/http-client@0.7.0
exports:
  kinds:
    - GithubClient
    - SearchRepos
---
kind: Telo.Definition
metadata: { name: GithubClient }
extends: Http.Client
schema:
  type: object
  required: [token]
  properties:
    token: { type: string }
base:
  baseUrl: https://api.github.com
  headers:
    Authorization: !cel "'Bearer ' + self.token"
    Accept: application/vnd.github+json
---
# An operation that inherits Http.Request's controller. base: builds the parent
# request from THIS instance's config; the request fields are computed from `q`.
kind: Telo.Definition
metadata: { name: SearchRepos }
extends: Http.Request
schema:
  type: object
  required: [client, q]
  properties:
    client: { x-telo-ref: "std/http-client#Client" }  # re-declared to expose it; forwarded below
    q: { type: string }
base:
  client: !cel "self.client"
  inputs:
    url: /search/repositories
    method: GET
    query:
      q: !cel "self.q"
```

Consuming it — the client is constructed from `{ token }`, and because it *is* a
`Client`, both the wrapped `SearchRepos` and a raw `Http.Request` can point at it:

```yaml
kind: Telo.Application
metadata:
  name: github-demo
  version: 1.0.0
imports:
  Gh: acme/github@0.1.0
  Http: std/http-client@0.7.0
secrets:
  ghToken: { env: GITHUB_TOKEN, type: string }
targets:
  - invoke: !ref TopRepos
  - invoke: !ref RateLimit
---
kind: Gh.GithubClient
metadata: { name: Api }
token: !cel "secrets.ghToken"
---
kind: Gh.SearchRepos                # a wrapped operation
metadata: { name: TopRepos }
client: !ref Api                    # GithubClient into the inherited std/http-client#Client slot
q: "stars:>10000"
---
kind: Http.Request                  # the escape hatch: a raw request for an unwrapped endpoint
metadata: { name: RateLimit }
client: !ref Api                    # same GithubClient, straight into Http.Request's client slot
inputs:
  url: /rate_limit
  method: GET
```

At runtime both instances are native instances of their parents: `Api` runs
`http-client`'s `Client` controller (from its `base:`-mapped config) and `TopRepos`
runs the `Request` controller. Because `Api` *is* a `Client`, it drops into every
`client` slot with no special handling.

## Inheritance vs. templated composition

Both let you define a kind without writing a controller — pick by intent:

| | Kind inheritance (`extends` + `base:`) | [Templated composition](/extend/templated-definitions) |
| --- | --- | --- |
| Identity | The instance **is** the parent (duck-types as it, `.snapshot()` etc.) | The instance wraps internal children and forwards a dispatch method |
| Reuse | One parent controller, preset via `base:` | Several existing kinds wired together |
| Substitutable at a parent's `!ref` slot | Yes, transitively | No — it is its own kind |
| Config | `base:` maps `self` onto the parent's config once | Internal `resources:` bodies are `self`-only |

Reach for **inheritance** when your kind is one existing kind, specialized. Reach
for **templated composition** when it is an assembly of several.

## `Telo.Abstract`

`Telo.Abstract` remains the **non-instantiable** base: it uniquely means *no
default implementation — must be extended*. Use it for a contract with no default
implementation (`Sql.Connection`, `Codec.Encoder`, `Ai.Model`, …); use plain
`extends` of a concrete kind when you want to reuse an existing controller.
