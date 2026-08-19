# Plan — Declarative UI: `modules/ui` + `modules/ui-react`

## Problem

Telo has no frontend story. The best an app can do is hand-write HTML/JS into `public/` and serve it with `Http.Static` (`examples/todo-app/telo.yaml`) — a second source of truth no analysis pass reads, so renaming a CRUD model property breaks the UI silently in production. `docs/guides/vs-low-code.md` records this as a weakness and sends "a one-off internal screen over a database" to another platform.

A backend module should serve its own UI. `Crud.Ui` over a `Crud.Resource`, composed into a page, checked by `telo check` like everything else.

## Solution

**What crosses the wire is a UI spec — data, not generated code.** The manifest evaluates to a JSON document; one prebuilt React bundle interprets it. Compiling React per manifest was rejected: it breaks no-build-step development, forecloses the Rust kernel, and makes the generated source a second source of truth.

**Two modules, split on the spec.** `modules/ui` owns the vocabulary and ships **zero client code**. `modules/ui-react` owns `Ui.App` (a `Telo.Mount`) and the browser bundle. `modules/crud` imports `ui` only — a backend module declares UI without depending on any renderer, which is what makes the spec a real contract and leaves an SSR-HTML renderer possible later (the `chart`/`chart-raster` split in `plans/svg-charts.md`).

**One tree grammar: a carrier for shape, kinds for providers.** `Ui.Nodes` is a `Telo.Type` schema-only carrier with one `$def` per structural node — box, stack, columns, text, badge, link, image, svg — recursive through `$ref`. This is the `http-dispatch` / `mcp-server` pattern that `plans/declarative-pdf-documents.md` also takes, and for its reasons: a structural node has no lifecycle and no runtime instance, so making each one a resource would create dozens of instances per page and fragment `x-telo-eval` coverage at every nested `{ kind }` boundary. **Composite nodes stay real kinds**, because they carry config and reference other resources: `Ui.Table`, `Ui.Form`, `Ui.Filters`, `Ui.Component`, and `Crud.Ui`. `Ui.Node` is the abstract they extend — `capability: Telo.Provider`, `outputType` anchored to the carrier root through `x-telo-schema-from` — and **one carrier `$def` variant is a reference to a `Ui.Node` provider**. That is the single extension hole: `children:` is always carrier data, and the recursion bottoms out in plain values.

**Composition is the existing template mechanism.** Providers' fields are compile-eval and `provide()` is parameterless; a template-form definition with a `provide:` body gets a synthesized `provide()`. So `Crud.Ui` is a definition with **no controller** that expands into carrier nodes, exactly as `Crud.Resource` expands into `Http.Api` routes.

**Eject is the invariant, not a feature.** *No node may be reachable only through a high-level kind.* Everything `Crud.Ui` generates must be hand-writable, so an author who needs more drops to the `Ui.Table` it would have produced and edits it. Enforced by an equivalence test in `modules/crud/tests/`.

**Styling is a published contract.** Every rendered element carries a stable `data-telo-part`, interaction state carries `data-state` / `data-invalid` / `data-sorted`, the bundle emits its own styles inside `@layer telo.base, telo.theme`, and author CSS lands unlayered so it always wins with no specificity fight. The default theme is a **declinable** stylesheet, not baked into the bundle. `Ui.Theme` is a token resource projected to CSS custom properties — the checked, editor-renderable surface — with part-selector CSS as the unchecked escape beneath it.

**Data-driven styling is a value, never a callback.** Manifests hold no functions, so a row or cell carries a `style:` accessor resolving to a theme token or part modifier — "mark overdue rows red" is data. This is the device `PdfMake.Document` uses for its totals row, and it is the only way conditional presentation stays statically typed.

**Custom components are an open seam.** A module declares a browser entry under `exports.browser:` on its module doc — module-level data, like `exports.code:`, because layer partitioning reads module-level claims. This adds a third code **role** (`browser`) to `collectModuleFileClaims` / `partitionLayers` and a browser build variant beside `CONTROLLER_BUNDLE_OPTIONS` in `kernel/nodejs/src/controller-loaders/source-bundle-builder.ts` (`platform: browser`, no `createRequire` banner, no realm externals, CSS bundled). `Ui.Component` names `(module alias, export)`; `Ui.App` serves the declaring module's browser layer content-addressed and the renderer dynamic-imports it, with React and the renderer's runtime supplied through an import map so there is exactly one React. The component ABI carries a declared version; a mismatch renders through the error node rather than white-screening.

**Data comes from the public REST API, which this plan expands.** `Crud.Resource`'s list route gains pagination, sorting, filtering and a total count; the list response becomes an envelope (`rows` + `total`) — a breaking change to the CRUD API, shipped as a minor per the repo convention. Sort and filter columns are constrained to the model's declared properties and values are bound as SQL parameters; the operator set is closed (equality, contains, comparison, membership). Column accessors are **plain chains** typed against the referenced model via `x-telo-context-ref-from: "crud/model"`, resolved by path in the browser — no CEL engine ships to the client. `columns:` is optional and derived from the model when omitted, so *adding* a field is a zero-edit change while a rename is a `CEL_UNKNOWN_FIELD` before deploy.

**The spec has a runtime-eval region.** Node fields are compile-eval by default, so the spec resolves once at load. A declared region of `Ui.App` is `x-telo-eval: runtime`, evaluated per spec request against the request context — which is what makes a role-conditional column or per-tenant branding expressible at all. Without it the spec is identical for every viewer, and with auth out of scope that would be permanent. Same device as `PdfMake.Document`'s runtime `content`. The handshake digest is computed over the **produced** spec, so a per-viewer spec still versions correctly.

**Delivery and liveness.** `Ui.App` serves the shell, the content-hashed immutable bundle and stylesheets, a `no-cache` spec document, an SSE channel (existing `Http.Api` stream mode + `SseCodec.Encoder`), and SPA-fallback client-side routing across its pages. The spec carries a digest and the bundle a version: a spec change is a soft re-render, a bundle change a hard reload. `telo run --watch` already reloads the kernel, so authoring liveness is reconnect-and-refetch — there is no author-written JS, so there is no module graph to hot-replace. Client validation uses the same model schema the API validates against, so the rules cannot diverge.

**Two things are verified before implementation, not assumed** — the discipline `plans/declarative-pdf-documents.md` applied to pdfkit's `brfs` trap. First, that a React bundle built through the new browser role actually runs under one shared React supplied by import map. Second, that `x-telo-schema-from` **rebases the carrier's internal `#/$defs/…` pointers** when anchored across kinds; if it does not, container recursion silently resolves against the wrong document — the risk the PDF plan names, inherited whole by adopting the carrier.

**Scope boundaries.** Inbound authentication does not exist anywhere in Telo and is not invented here: the renderer sends same-origin credentials and renders 401/403 through the error node. Editor canvas preview is deliberately not in this plan.

Ships with `modules/ui/docs/` and `modules/ui-react/docs/` per kind, updated `modules/crud/docs/`, a `UI` category label, `requires:` lower bounds on every module using the new syntax, changie fragments, tests in `modules/ui-react/tests/` and `modules/crud/tests/`, and the authoring-agent primer update CLAUDE.md requires of any surface change.

## Decisions

- **Spec over generated code.** Codegen breaks no-build-step development, forecloses non-Node kernels, and creates a second source of truth. The spec is data every kernel can produce.
- **`ui` / `ui-react` split, not one module.** Keeps `modules/crud` free of any renderer dependency and makes "the spec is the contract, renderers are swappable" structural rather than aspirational.
- **A carrier for structural nodes, kinds for composites.** Rejected a kind per node: dozens of lifecycle-less resource instances per page and `x-telo-eval` coverage stopping at every nested `{ kind }`. Rejected a carrier alone: closed by construction, so no module could contribute a node — the openness this design exists to keep.
- **One `$def` variant is a provider reference.** A single extension hole keeps `children:` uniformly carrier data instead of a union of "data or resource" at every container.
- **Explicit discriminator on node variants** — knowingly diverging from `plans/declarative-pdf-documents.md`, which discriminates by which key is present to keep pdfmake copy-paste literal. UI mirrors no incumbent vocabulary, so it spends that budget on error quality instead.
- **No raw markup node.** Rejected `Ui.Html` on the PDF plan's reasoning — it voids static validation and visual editing for its whole subtree — plus an XSS surface PDF does not have. `Ui.Component` already covers extension, with types.
- **`Crud.Ui` is a template, not a component.** The renderer stays kind-agnostic (the topology-driven constraint applied to the browser) and any module can ship a UI kind with zero client code.
- **No node reachable only via a high-level kind.** The framework failure mode is a high-level component with no lower level to fall to. Tested, not asserted.
- **Open component seam over a closed vocabulary.** Closed covers styling and structure via CSS and eject, but not novel interaction, which is precisely where "the framework doesn't provide it" recurs. The cost — a client plugin ABI that becomes public API — is accepted and versioned.
- **`exports.browser:`, not a `Ui.Component` file field.** Layer partitioning reads module-level claims; a per-resource path could not be packaged.
- **A runtime-eval spec region.** Without it no UI can differ per viewer, which auth being deferred would make permanent rather than temporary.
- **Default theme declinable, styles in cascade layers.** Baked-in defaults make every override a specificity fight; cheap now and painful to retrofit.
- **`data-telo-part` is public API.** CSS fails silently, so the part vocabulary is written down as a contract from the first release rather than discovered from the DOM.
- **Theme tokens stay per-medium.** `Ui.Theme` lives in `modules/ui`; `pdfmake` keeps `styles` / `defaultStyle` and `chart` keeps `palette`. A neutral shared token module was considered and rejected — it couples three modules' release cadence to one vocabulary before any has shipped, and the duplication is a handful of literals.
- **Plain-chain accessors, not full CEL.** Keeps CEL's static checking while resolving by path in the browser; shipping a CEL evaluator to the client was rejected on weight and on having two evaluation environments.
- **Extend the CRUD list route rather than give the UI a private query path.** The public API gets pagination and filtering it needs regardless, and a private backdoor would fork the query path.
- **Closed filter operators, model-constrained sort columns.** Column names reaching SQL come from the declared model only; anything else is an injection surface.
- **Envelope list response.** A table needs a total count; a bare array leaves no place for it. Breaking, minor, deliberate.
- **Auth deferred, not designed around.** Nothing inbound exists to build on; inventing a UI-local session would be the wrong place for it.

## Example after the change

```yaml
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
mounts:
  - path: /api/todos
    mount: !ref TodoApi
  - path: /
    mount: !ref Admin
---
kind: Crud.Resource
metadata:
  name: TodoApi
connection: !ref Db
singular: todo
plural: todos
model:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [text]
    additionalProperties: false
    properties:
      text: { type: string, minLength: 1 }
      isDone: { type: boolean }
      dueOn: { type: string }
---
kind: UiReact.App
metadata:
  name: Admin
title: Todo Admin
theme:
  kind: Ui.Theme
  tokens:
    color.accent: "#1f8fff"
    color.danger: "#c4341b"
    radius.md: 6px
stylesheets:
  - ./ui.css
pages:
  # One line: columns, filters and the create/edit form derive from the model.
  - path: /
    title: Todos
    children:
      - node: !ref TodoList

  # Ejected: what Crud.Ui expands to, edited. Structural nodes are plain data;
  # only Ui.Table and the component cell are resources.
  - path: /done
    title: Completed
    children:
      - stack:
          - text: Completed this week
            style: heading
          - node: !ref DoneTable
---
kind: Crud.Ui
metadata:
  name: TodoList
crud: !ref TodoApi
basePath: /api/todos
---
kind: Ui.Table
metadata:
  name: DoneTable
source:
  basePath: /api/todos
  filters: { isDone: true }
# Data-driven styling is a value, not a callback.
rowStyle: !cel "row.dueOn < now ? 'color.danger' : ''"
columns:
  - header: Task
    value: !cel "row.text"
  - header: Status
    cell:
      component:
        module: Badges
        export: StatusPill
        props:
          done: !cel "row.isDone"
```
