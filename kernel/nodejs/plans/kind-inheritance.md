# Kind inheritance (general `extends`)

## Implementation status

**Complete — nothing deferred.** The feature works end-to-end (both the `base:`
narrowing and the no-`base:` additive-merge paths) and is covered by tests.

- Shared `analyzer/extends-resolution.ts` (ancestor walk, inherited capability,
  controller-bearing ancestor, effective author schema) — reused by kernel + analyzer.
- Kernel delegation (`resource-inherited-controller.ts` + `_createInstance` →
  `createInheritedInstance`, a typed context seam): `base:` is evaluated over `self`
  (reference slots resolved to live instances) or — without `base:` — the child's own
  config is forwarded; the parent kind is constructed through the ordinary create
  pipeline and the native parent instance is returned verbatim. Capability is stamped
  from the chain (drives compile-CEL eval paths + `capabilityOf`).
- Analyzer: `EXTENDS_NON_ABSTRACT` removed; `EXTENDS_CAPABILITY_MISMATCH` added;
  `checkKind` + `acceptedKindsForRef` accept transitive subtypes for concrete and
  abstract targets alike; `base:` CEL types `self` from the child's own schema;
  **`validate-base-mapping.ts` statically validates `base:` against the parent config
  schema** (`BASE_MISSING_REQUIRED` / `BASE_UNKNOWN_FIELD` / `BASE_SCHEMA_MISMATCH`);
  `buildSelfSchema`, the definition-registry **field map** (lazy, from the effective
  author schema), and **per-instance resource validation** all use the effective
  (inheritance-resolved) schema, so the no-`base:` merge case validates against the
  inherited fields; provider-coherence skips the missing-implementation error for
  inherited controllers.
- Value-flow typing: `resources.<child>` is typed as an opaque object exactly like
  every resource (kernel-globals) — never from the child's input schema — and step
  `outputType` already falls back through `extends`; so the value-flow contract holds
  with no per-kind change needed.
- http-client request controller resolves a local `client` slot through the live
  instance (an inherited Client works inside a Run.Sequence scope).
- Tests: `tests/inherited-http-client.yaml` (E2E — `base:` client used in a scope),
  `tests/inherited-http-client-merge.yaml` (E2E — no-`base:` additive merge),
  `tests/base-schema-mismatch.yaml` (static `BASE_SCHEMA_MISMATCH`), and the
  repurposed `tests/extends-non-abstract.yaml` (capability-mismatch). Analyzer +
  kernel unit suites green.

## Problem

Telo's `extends` today only lets a `Telo.Definition` implement a `Telo.Abstract`.
There is no way to define a kind that **specializes an existing concrete kind** —
reusing its controller/behavior while presenting a friendlier schema and preset
config. The motivating case: a `YouTrackClient` that is, for all runtime and
type purposes, an `std/http-client#Client` preconfigured from `{url, apiKey}`,
so it can be `!ref`'d into anything that expects a Client. Every workaround
explored (delegating-provider wrappers, abstract-ifying `http-client#Client`)
either can't produce the client's runtime contract from pure manifest, or forces
invasive changes on a shared base module. The clean primitive is ordinary
single inheritance: any kind may extend any other kind.

## Solution

Make `extends` general and OOP-shaped, entirely within `@telorun/analyzer` and
`@telorun/kernel` (no change to `http-client` or any other module).

A `Telo.Definition` may `extends` **any** kind — concrete or abstract —
single-parent, transitive. A child:

- **inherits the parent's controller by delegation.** When a child declares no
  own `controllers:` and no template body, the kernel's
  `resource-definition-controller` resolves an ancestor's controller, evaluates
  the child's `base:` mapping, calls the ancestor controller's `create()` with
  the mapped config, and **returns that instance verbatim**. The child instance
  therefore *is* a parent instance and duck-types identically (e.g. it has the
  Client's `.snapshot()`), so consumers and Phase-5 ref injection need no
  awareness of the subclass — instance identity is free. (CEL reads of
  `resources.<child>` follow the parent's value-flow, not the child's input
  schema — see *Value-flow typing* below.)
- **inherits capability, immutably.** A child may omit `capability` (inherits the
  ancestor's) or restate it identically; declaring a *different* capability than
  an ancestor is a hard error (analyzer diagnostic + kernel guard). No silent
  capability change.
- **inherits `schema:` — additively, or narrowed when `base:` is present.** With
  **no** `base:`, the child's author-facing schema is `merge(parent, own)` (child
  overrides) — a pure additive extension exposing the parent's config fields plus
  its own, reusing the `mergeTypeSchemas` that `Type.JsonSchema.extends` uses.
  With `base:`, the author-facing schema is the child's **own schema only**: the
  parent's input fields become internal, set *solely* through `base:`, so the
  child genuinely narrows (an author sets `url`/`apiKey`, never `baseUrl`). This
  is the single source of truth for the parent's config — no dual direct-field vs
  `base:` channel — and governs `self` typing (`buildSelfSchema`), the reference
  field map, and per-instance validation alike.
- is **Liskov-substitutable** for every ancestor at any `x-telo-ref`/`!ref` slot,
  transitively (kind-based; independent of the schema rule above).

**New primitive — `base:` ("super(...)").** A top-level sibling on the
definition: an object of CEL expressions over `self` (typed from the child's own
schema), evaluated once and AJV-checked against the parent's schema, producing the
config passed to the inherited controller. It mirrors the existing
`inputs:`/`result:` top-level-sibling factoring. `base:` constructs the parent's
config **once**; how that config then *behaves* is the **parent controller's**
contract — fixed for kinds that consume config in `create()` (e.g. `Http.Client`),
or baked defaults the controller re-layers per call (e.g. `Http.Request`, whose
`inputs` a caller can override). So `base:` is the genuinely new concept for
`create()`-consuming parents; for `invoke()`-layering parents it mainly supplies a
friendly custom schema + a CEL mapping onto the parent's existing manifest-inputs
layer.

**Value-flow typing.** `resources.<child>` (CEL value-flow reads) is typed from
the **inherited value-flow contract** — the parent's `outputType` / snapshot
projection — **never** the child's input schema, so construction-only fields
(`url`, `apiKey`) are *not* readable off `resources.<child>` and static typing
matches the parent instance that actually flows. If the parent declares no
value-flow type, `resources.<child>` is opaque exactly as the parent's is.

`Telo.Abstract` is **retained**, demoted from "the only supertype mechanism" to
"the non-instantiable flavor of base": it still uniquely means *no default
implementation — must be extended* (load-bearing for `Sql.Connection`,
`Codec.Encoder`, `Ai.Model`, `Cache.Store`, `Mcp.SessionProvider`, …). Its only
remaining special behavior is that instantiating one is an error and it has no
`base:`/controller to inherit. The ref-matching special case for abstracts
disappears (see below).

### Change surface

**`@telorun/analyzer`**
- `validate-extends.ts` — relax `EXTENDS_NON_ABSTRACT` to accept concrete targets;
  add the capability-mismatch diagnostic (child capability differs from ancestor).
- `validate-references.ts` `checkKind` + `analysis-registry.ts` `acceptedKindsForRef`
  — collapse the abstract/concrete split into one transitive subtype check over the
  already-transitive `getByExtends`; `kernel.ts` instantiation-hint message likewise.
- Author-facing schema resolution — `merge(parent, own)` when no `base:`, else the
  child's **own** schema (parent input fields internal) — wired into
  `buildSelfSchema`, `definition-registry.register` (field map), the
  eval-path/coherence walks, and per-instance validation. Type and validate `base:`
  against the parent schema (same shape as the `result:`-vs-`outputType` check).
- Value-flow typing: type `resources.<child>` from the inherited value-flow
  contract (parent `outputType`/snapshot projection), not the child input schema;
  opaque when the parent declares none.
- Walk `extends` for inherited `capability`/`throws` where those are read today
  (`validate-provider-coherence.ts`, eval-path merge in `analyzer.ts`).

**`@telorun/kernel`**
- `controllers/resource-definition/resource-definition-controller.ts` — third
  branch: inherited-controller delegation (resolve ancestor controller, eval
  `base:`, delegate `create()`, return instance verbatim), composed with lazy
  controller loading.
- Ancestor-walk in controller/capability resolution (`controller-registry.ts`,
  `kernel.ts` `_createInstance`, `evaluation-context.ts` `capabilityOf` /
  `getDeclaredThrowCodes`).
- `manifest-schemas.ts` — allow `base:`; keep `extends` single-string.
- Fix the vestigial scope-path client lookup in http-client's request controller
  path so an inherited child used inside a scope resolves through the live
  instance (the one place duck-typing reads a raw manifest today).

**Cross-cutting:** changesets for `@telorun/kernel` + `@telorun/analyzer`;
analyzer + kernel tests including a concrete-extends-concrete case with `base:`.

**Docs:** update `CLAUDE.md` (extends/capability/abstract sections) and the kernel
`resource-references.md`; **add a new Docusaurus guide page**
`docs/extend/kind-inheritance.md` — an in-depth explanation of kind inheritance
(extends any kind, inherited controller/capability/schema, the `base:` mapping,
substitutability, and how it differs from templated composition), with worked
examples built around a **GitHub API client**: `GithubClient extends Http.Client`
(token → `Authorization` header, base `https://api.github.com`) plus operations
`extends Http.Request` (e.g. a repo search), mirroring the YouTrack example above
but as the docs' running example. Wire it into `pages/sidebars.ts` under the
"Extend" category (beside "Templated Definitions") and the Docusaurus `include`,
with `sidebar_label` frontmatter — per the mandatory module-docs wiring.

**Authoring-agent system prompt:** update the manifest-authoring primer in
`apps/authoring-agent/chat/telo.yaml` (the `system:` block) — add guidance on
building libraries with inheritance: `extends` any kind (not just abstracts), the
`base:` construction mapping, capability is inherited and immutable, and when to
use inheritance vs. templated composition; revise the `Telo.Abstract` line to its
narrowed role (the non-instantiable base). Use a **GitHub client library** as the
worked example (`GithubClient extends Http.Client`, operations `extends
Http.Request`). Add a changie fragment for the `authoring-agent` app. The human
authoring guide `docs/extend/authoring-a-module.md` gets the same inheritance
section and links the new guide page.

## Decisions

- **Inherit the controller by delegating and returning the parent's instance
  verbatim** — makes the child duck-type as the parent with zero changes to base
  modules; the alternative (wrap in a template that forwards methods) can't forward
  passive duck-typed contracts like `.snapshot()`.
- **`base:` as the config-mapping primitive** — no existing mechanism maps config
  once, at construction, into a reused controller's `create()`; the per-call
  template dispatch verbs and `Type.JsonSchema` schema-merge each cover only half.
- **Single inheritance** for controller-bearing kinds — a diamond has no clean
  `create()` resolution order; multiple inheritance is deferred and, if added, is
  scoped to pure schema-only mixins (no controller).
- **Capability inherited but immutable** — inheritance should not let a kind change
  its lifecycle role; a mismatch throws rather than silently reinterpreting.
- **`base:` narrows the schema** — when present, the child's author surface is its
  own schema and `base:` is the sole channel to the parent's config, so there is no
  dual (direct-field vs `base:`) path with undefined precedence; schema merge stays
  additive only for `base:`-less extensions.
- **Value-flow follows the parent, not the child's inputs** — `resources.<child>`
  is typed and flows as the inherited provider's value, not the child's
  construction schema, keeping static typing aligned with runtime.
- **`base:` timing is construction; downstream fixity is the parent controller's** —
  fixed for `create()`-consuming parents (`Http.Client`), overridable baked defaults
  for `invoke()`-layering parents (`Http.Request`). `base:` does not itself promise
  immutability.
- **Keep `Telo.Abstract`** — general `extends` subsumes its *supertype* role but not
  its *non-instantiable interface* role, which much of the stdlib depends on.
- **Rejected:** a new `delegate:`/wrapper field (narrowly reinvents inheritance);
  abstract-ifying `http-client#Client` (changes a shared module, and would have to
  be repeated per base kind).

## Example after the change

All snippets are illustrative — the youtrack module is a separate follow-up; they
exist only to pin down the intended behavior of this feature.

**1. A kind specializing a concrete kind — the canonical `base:` case.**
`YouTrackClient` inherits `Http.Client`'s controller and capability (a Provider
whose config is consumed at construction), and maps its friendly `{url, apiKey}`
onto the parent's config via `base:`. Because `base:` is present, its author-facing
schema is exactly `{url, apiKey}` — `baseUrl`/`headers` are internal, set only here:

```yaml
kind: Telo.Definition
metadata: { name: YouTrackClient }
extends: Http.Client            # concrete parent; capability (Provider) inherited, immutable
schema:
  type: object
  required: [url, apiKey]
  properties:
    url: { type: string }
    apiKey: { type: string }
base:                            # declarative: the base kind's config, derived from self
  baseUrl: !cel "self.url + '/api'"
  headers:
    Authorization: !cel "'Bearer ' + self.apiKey"
```

**2. Inheriting a concrete Invocable — the controller-dependent case.**
`SearchIssues` extends `Http.Request`, inheriting its controller. Since `base:` is
present, its author surface is its **own** schema; the `client` it wants to expose
is re-declared here (and forwarded in `base:`), while the request fields are
computed by `base:` from `query`/`top`:

```yaml
kind: Telo.Definition
metadata: { name: SearchIssues }
extends: Http.Request            # concrete Invocable parent; controller inherited
schema:
  type: object
  required: [client, query]      # with base:, the child's own schema IS its author surface
  properties:
    client: { x-telo-ref: "std/http-client#Client" }  # re-declared to expose it; forwarded below
    query:  { type: string }     # a YouTrack search query
    top:    { type: integer, default: 50 }
base:                            # build the parent request from THIS instance's config
  client: !cel "self.client"
  inputs:
    url: /issues
    method: GET
    query:
      query:    !cel "self.query"
      "$top":   !cel "string(self.top)"
      fields:   idReadable,summary,state(name)
```

`base:` here supplies the request's **baked defaults**, computed once from the
instance's own `query`/`top`. Unlike Example 1, these are *not* fixed at
construction: `Http.Request` re-layers `inputs` on every `invoke()`, so a caller
can override them — `base:` constructs, but the parent controller decides fixity.
Inputs that must genuinely vary per *invocation* (a different `issueId` each call)
aren't a `base:` concern at all and stay composition — the youtrack follow-up, not
this feature.

**3. Usage — a consuming `Telo.Application`** that imports the youtrack library
(aliased `Yt`) and http-client (`Http`), instantiates the client, one wrapped
operation, and one raw request, and invokes both. The raw `Http.Request` shows the
escape hatch: because `Acme` *is* a `Client`, users can hit any endpoint the module
doesn't wrap by pointing a plain request at the same client:

```yaml
kind: Telo.Application
metadata:
  name: youtrack-demo
  version: 1.0.0
imports:
  Yt: jetbrains/youtrack@0.1.0
  Http: std/http-client@0.7.0
variables:
  ytUrl: { env: YOUTRACK_URL, type: string }
secrets:
  ytToken: { env: YOUTRACK_TOKEN, type: string }
targets:
  - invoke: !ref openBugs
  - invoke: !ref boards
---
kind: Yt.YouTrackClient
metadata: { name: Acme }
url: !cel "variables.ytUrl"
apiKey: !cel "secrets.ytToken"
---
kind: Yt.SearchIssues              # a wrapped operation
metadata: { name: openBugs }
client: !ref Acme                  # YouTrackClient into the inherited std/http-client#Client slot
query: "project: ACME State: Open type: Bug"
top: 100
---
kind: Http.Request                 # a raw request for an endpoint the module doesn't wrap
metadata: { name: boards }
client: !ref Acme                  # same YouTrackClient, straight into Http.Request's client slot
inputs:
  url: /agiles
  method: GET
```

At runtime both instances are native instances of their parents: `Acme` runs
http-client's Client controller (from its `base:`-mapped config) and `openBugs` runs
http-client's Request controller, its query/`$top`/`fields` computed by `base:` from
`openBugs`'s config. Because `Acme` *is* a `Client`, it drops into `openBugs`'s
inherited `client` slot with no special handling.
