# The module graph

## Problem

The Topology tab has been rebuilt several times and no version reads as *the*
picture of an application. Each attempt models a slice — a reference graph, a
containment tree, a step list, a route table — and a reader who wants to know
what the app does has to assemble the answer from six partial views. Before
another shape is proposed, this document fixes what the graph has to support,
so a candidate design can be measured against it rather than against taste.

Nothing below is a design decision. It is the surface: what a Telo manifest can
say, what a reader needs to ask, and what the editor must let them do about it.

## Requirements

### 1. Declaration forms a node can arrive in

All seven occur in shipped manifests, and they are different things visually:

1. **Named top-level resource** — one declaration, referenced N times. Sixty of
   them in the hub.
2. **Inline declaration at a ref slot** — `invoke: { kind: …, …config }` with no
   `metadata.name`. The analyzer extracts these into first-class resources under
   a synthesized name, recursively for nested inlines, recording the authored
   origin. These are the only resources genuinely *owned* by one parent. The
   editor's view does not see them today.
3. **`with:`-scoped resource** — declared inside a step body, one instance per
   scope run, torn down when the run ends; the name resolves scope-first, then
   the enclosing module. 66 sites, mostly standing a server up around a test.
4. **An imported library's exported instance** — `!ref Alias.name`. A node owned
   by another module. In `url-shortener` the whole application is behind three
   of them.
5. **A resource handed *into* a library** — the `resources:` block on a
   `Telo.Library`, supplied at the import's object form. Borrowed, owned by the
   importer; the edge points inward, the opposite of an export.
6. **Shared-library singleton vs isolated** — `lifecycle: shared` is one instance
   the whole application resolves to, `isolated` is one per import declaration.
   Same YAML, different node count.
7. **Kind declarations** — `Telo.Definition` / `Telo.Abstract` are a second
   plane: `extends` (single, transitive), `base:`, template bodies (`resources:`
   / `invoke:` / `run:` / `provide:` with `inputs:` / `result:`), `capability`,
   `exports.kinds`. `custom-kind` is an example whose entire content is kinds.

Plus the module root, which is not a resource but carries `targets`, `imports`,
`variables`, `secrets`, `ports`, `logging` (with inline `sinks`), `include`,
`exports` and `requires`.

### 2. Reference edges — every shape a slot takes

- **Slot positions**: scalar (`connection`), array of refs (`tables[]`,
  `targets[]`), a ref inside an array of objects (`mounts[].mount`,
  `routes[].handler`, `contentTypeParsers[].parser`), map-valued slots, a ref
  under a generic dispatch key (`notFoundHandler.invoke`), refs inside a step
  body at arbitrary depth, and a ref as one *branch of a union* whose other
  branch is a plain value (a column's `type:`).
- **Several slots per kind, meaning different things.** `Http.Server` carries
  `mounts[].mount`, `notFoundHandler.invoke` and `contentTypeParsers[].parser`.
  `Cache.View` carries `store:` and `invoke:` — the same pair of nodes connected
  twice, which is why the edge set is a multigraph keyed by slot path rather
  than by node pair.
- **`use:` is the edge's meaning**, and the stdlib distribution is lopsided:
  `dependency` 86, `schema` 30, `call` 12, `trigger.inbound` 8, `detached` 1,
  `trigger.consumer` 1 — plus sets (`[call, detached]`), case maps selected by a
  sibling field, and legacy slots declaring no `use` at all. Drawing all of these
  as one kind of line draws three unrelated relations on top of each other:
  mounts are `dependency`, route handlers are `trigger.inbound`.
- **The kind constraint per slot** is one kind, a kind list, or a capability
  group (`Telo.Executable`) expanded transitively through `extends`. It decides
  whether a drag is legal and what a create-and-link may offer.
- A slot may hold an **inline declaration** instead of a ref, and a ref may be
  **unresolvable** — dangling name, unknown alias, unresolved import, a kind the
  target library does not export.

### 3. Edges that are not references

None of these are drawn today, and each is load-bearing:

- **`targets:`** — an ordered boot list that is also a step list: entries are
  bare refs, `{ref, when}`, or inline invoke steps with `inputs`, and a later
  target reads an earlier one's `steps.<name>.result`.
- **CEL reads across resources** — `resources.<name>.<field>` and
  `resources.<name>.status.<field>`. A config provider read by five resources
  has five real edges the reference graph does not carry.
- **`steps.<name>.result` within a body** — the data-flow DAG *inside* a node,
  which is what makes a sequence readable. The hub's registration sequence
  chains eight steps through it, four levels deep.
- **Scope reads** — `variables`, `secrets`, `ports`, `module`, and the context
  bindings `request` / `item` / `error` / `inputs` / `result` / `self`.
- **Execution zones** — `x-telo-provides-zone` / `x-telo-requires-zone` define a
  region: everything reachable through `Sql.Transaction.steps` runs inside the
  transaction, and a requiring resource is *unreachable* except through it. The
  zone attributes (`atomic`, `noSuspend`, `idempotent`, `replayed`) are claims
  about that region's contents. This is a containment fact that is real.
- **Error paths** — the `throws:` union propagates along `call` edges and is
  discharged at a `catches:` arm several hops away. `order-webhook` renders
  `ERR_CLAIM_LOST`, raised three resources below the route that catches it.
- **Initialization order vs control flow** — two different orders over the same
  nodes, derived from different edge subsets.

### 4. Node interiors

- **Step bodies** — `invoke` / `value` / `if` / `while` / `switch` / `try` /
  `throw`, with `when`, `retry`, `catches`, `inputs`, `outputs`, nested to
  arbitrary depth. *Any* kind can carry one (`Run.Sequence`, `Sql.Transaction`,
  a durable workflow), so this is annotation-driven and never kind-driven.
- **Entry lists** — `x-telo-topology-role: entries` with `matcher` and
  `handler`: HTTP routes, MCP tools / prompts / resources, mounts. Each entry
  carries configuration (path, method, request schema, `returns`, `catches`)
  *plus* a dispatch, and the order is match order.
- **`with:` blocks and a sequence's own `targets:`.**
- **Template bodies** on a kind declaration.
- **The `inputs:` map at every call site**, typed by the target's `inputType` —
  where most of the CEL in a real application lives.

### 5. Facts a node carries

Capability (`Service` / `Runnable` / `Invocable` / `Provider` / `Mount` / `Sink`
/ `Type`); its contract (`inputType` / `outputType`, declared on the instance or
inherited from the kind); declared observed state (`status:`) and whether
anything can start the producer; bound ports; diagnostics (per resource, per
file, and unattributed) with a severity rollup; the file and document that
declares it, since a module spans `include:` partials and an edit has to land in
the right one; kind provenance (local, `Self.`, an imported alias, a built-in)
and deprecation.

### 6. Questions the graph must answer

- **Where does work enter?** Ports, route table, schedules, MCP tools, boot
  targets — today scattered across four kinds and readable in none of them.
- **What happens when a request arrives?** The chain across resources and into
  step bodies, through decorator-shaped nodes that wrap another resource:
  `Idempotency.Once`, `Cache.View`, `Run.Detach`, `Sql.Transaction`,
  `RateLimit.Guard`.
- **What depends on this, and what breaks if I change it?** Reverse edges, which
  no current view offers.
- **What starts the application, in what order?**
- **What is shared and what is single-use?** One `db` under two statement
  resources under two sequences; one `Exec` invoked from a dozen steps. The
  hub-and-spoke shape is the normal case, not a pathology.
- **Which parts are mine and which are imported** — and can I look inside an
  imported library? `url-shortener`'s root is sixty lines; the application is in
  the libraries.
- **What is unwired** — declared, referenced by nothing, in no `targets`.
- **What runs inside a transaction or a durable region?**
- **Where are the errors**, and which slots are *empty*: an unfilled reference
  matters as much as a filled one.
- **The data plane** — tables, columns, enums, declared types, and which
  statements touch which table.

### 7. Interaction and editing

- **Navigate**: select to peek, open, breadcrumb back, jump to the source line
  and back, jump from a diagnostic, jump from the outline.
- **Edit**: wire and unwire a reference; create-and-link a resource of an
  accepted kind; delete; **reorder ordered lists** — `targets`, steps, routes,
  mounts, where order is semantic; edit a call's `inputs:`; add and remove
  entries; add, move and delete steps; edit the focused node's own
  configuration.
- **Refuse an illegal wire by the slot's declared constraint**, and say why.
- Write-back is a surgical edit into the declaring document with comments and
  formatting preserved. YAML stays the source of truth, so **no positions are
  written to it** and layout is always derived.

### 8. Degradation

Usable while imports are still resolving in the background; on a manifest with a
parse error; with an unresolved import, where kinds and therefore capabilities
are unknown; with a dangling reference; with a kind that has no schema; and on a
module that is a Library rather than an Application. Anything unknown is shown
as unknown and never silently dropped — the no-swallowed-errors rule applied to
the canvas.

### 9. Envelope

Around 60 resources and 90 edges in one module, with a single node carrying a
dozen incoming edges; sequences of 20+ steps nested four deep; recomputation at
keystroke time; layout stable across edits, with viewport and selection
preserved across re-analysis.

### 10. Invariants

- **Topology-driven**: no kind names in the editor. Everything comes from
  capability, the `x-telo-*` annotations and the registry, so a third-party kind
  renders as well as `Http.Server`.
- **Browser-safe and kernel-free**: static analysis only; there is no running
  kernel to ask.
- **Visual editing is a product goal**: the graph is the primary authoring
  surface, not a read-only picture.
- **Identity must match the runtime graph** the debug stream already drives — a
  node born on `Created`, brightening on `Initialized`, pulsing per invocation,
  plus per-invocation trace subgraphs — so a run overlay needs no second node
  model.

### 11. What the existing attempts get wrong

A candidate design has to beat these, and each is a concrete failure rather than
a preference:

- **The capability partition sends Providers to a side strip**, and
  `Sql.Connection`, `Cache.Store`, `KvStore.Store`, `Ai.Model` and `Sql.Table`
  are all Providers: the most-referenced nodes in every application are the ones
  excluded from the graph.
- **Containment is inferred from reachability**, so a DAG is expanded into a
  tree, a shared node is "inside" each of its referrers, and a mount reads as a
  child of its server although the slot is `use: dependency`. The genuine
  containment relations — zones, `with:` scopes, inline declarations — are not
  the ones being drawn.
- **Inline and `with:`-scoped resources are not nodes at all**, though they are
  the only truly owned children.
- **Imported libraries are opaque leaves.**
- **Nesting consumes the edge**, so "in the Application's targets" degrades to
  "inside the Application".
- **Steps are flattened into indented rows**, losing branch structure and
  step-to-step data flow.
- **Two canvas stacks** and a per-focus view registry, so one application is six
  partial pictures instead of one.

## Solution

### The principle: three primitives, each earned by a manifest fact

Every previous attempt picked one relation and drew it as *the* picture, then
bolted the rest on as strips, chips and rows. A manifest carries four relations
at once and they are not interchangeable, so the canvas has one node model and
three drawing primitives:

- **Box** — a declaration and what it *owns*. Its interior is a step body, an
  entry list, a `with:` scope, its inline children, or a template body.
- **Row** — one **ordered** entry inside a box: a step, a route, a mount, a
  target, a `catches:` arm.
- **Edge** — a **reference leaving a port**, classed by `use`.

The rule that falls out is that **order is drawn as order and wiring is drawn as
wiring**. A route table is rows inside the `Http.Api` box — not six nodes, and
not a separate Routes view — and each row's `handler` port emits one edge. A
sequence is rows inside its box, each `invoke` row emitting an edge. This is what
dissolves the table-versus-graph tension that produced two canvas stacks and six
views, and it is what makes reordering expressible at all: `targets`, steps,
routes and mounts are order-significant, and a row drag is the honest gesture for
changing them.

### Nodes

Every resource in scope, whatever declaration form it arrived in. Identity is the
declaration site — the same thing the kernel stamps when it creates an instance,
so a runtime overlay from the debug stream needs no second node model.

**Identity is anchored on names, never on indices.** A named resource's identity
is its declaration site. Rows and inline children are the cases where those two
readings conflict: an entry addressed by array index shifts its path when a
sibling is inserted above it, so index-keyed identity detaches selection and
sticky expansion precisely while the user is editing — the primary use case.
(The migration driver refuses indexed matches into resized arrays for the same
reason: a stale key resolves to nothing, a stale index silently names a
different element.) So: where the grammar offers a name, the name is the
identity — steps are nameable, and a synthesized inline name records its
authored origin; where it does not (an unnamed route, a `catches:` arm), the
identity is the nearest named ancestor plus a content-derived key, never a bare
index. The runtime mapping is stated rather than assumed: a declaration site
maps to one instance for a named resource and to one instance *per scope run*
for a `with:`-scoped one, so a run overlay joins on declaration site plus the
run's own id.

Each node carries an **ownership class**, and the class decides where it is
drawn, not merely how it is decorated:

- **inline** — rendered *inside* its parent's box. It exists nowhere but that
  parent's YAML, so it is never a peer.
- **scoped** — inside its `with:` box, with the per-run lifetime stated there.
- **named** — a box in its band.
- **imported** — not a box at all: a drawer row, named by the alias it is
  reached under.
- **injected** — a library's `resources:` input, drawn with its edge pointing
  inward from the importer that supplies it.

### Ports

One per reference slot, in schema order, labelled from the slot's title, **empty
ones included** — an unfilled slot is as much a fact about the application as a
filled one, and it is the affordance for filling it. An unfilled slot therefore
carries the PATH a value would be written at: resolving the manifest for
`notFoundHandler.invoke` on a server that declares no `notFoundHandler` yields
nothing, so without that the port drew a socket that could not be filled, which
is worse than not drawing one — it offers an affordance and then refuses.
An ordered array carries the path a NEW entry would be written at, for both
shapes it takes (`targets[]` → `targets[2]`, `mounts[].mount` → `mounts[2].mount`). `Http.Server` therefore
shows `mounts`, `notFoundHandler` and `contentTypeParsers` as three distinct
rows; `Cache.View` shows `store:` and `invoke:` as two, which is why the same
pair of nodes can be connected twice and why an edge is keyed by slot path rather
than by node pair. The port's declared kind constraint — one kind, a kind list,
or a capability group expanded through `extends` — is what validates a drag and
what a create-and-link offers.

### Edges

Six `use` values collapse into three **drawing** classes, because what a reader
needs to distinguish is whether control transfers, not which of four ways it
transfers:

- **flow** — `call`, `detached`, `trigger.inbound`, `trigger.consumer`. Solid and
  directed; `detached` dashed, since the caller does not await it.
- **holds** — `dependency`. Thin and low-contrast. **Collapse keys on the target
  band, not on `use` alone**: a hold into the pinned infrastructure band
  collapses to a count badge (the standard library declares 86 `dependency`
  slots against 12 `call`, and holds on shared infrastructure are the single
  largest source of hairball), while a hold between centre nodes stays drawn —
  a server holding its mounts is the structural spine of the application, and
  demoting it alongside connection fan-in is the mistake §11 records.
- **shape** — `schema`. Not an edge at all; a type annotation on the node, since
  no runtime relation exists.

An ambient hold is therefore **picked, not wired**: the slot draws a select over
the names that may fill it, no socket, and no chevron. A socket that can never
carry a line is an affordance with no result, and the collapsed name shown as
static text made the field a reader most often wants to change reachable only
through the detail panel. The select offers exactly what a drag onto that slot
would have been allowed to land on — one acceptance rule, so the two ways of
filling one slot cannot disagree — plus `New <Kind>` where nothing of the kind
exists yet, which rides the same write so creating the resource and pointing at
it stay one workspace mutation. An array-valued hold draws a row per entry plus
one for the next, which is how a schema's first table is added at all.
**`holds` is part of the rule, not a convenience**: `Ai.Model` declares
`capability: Telo.Provider` and is genuinely called, so its slot keeps its
socket — what makes a slot pickable is that control never transfers through it.

Beside them ride the edge sets that are not references at all: **boot**
(`targets`, ordered, and itself a step list — a later target reads an earlier
one's `steps.<name>.result`; the call graph walks the module doc like any other
resource, so a boot target is an ordinary edge with a flag, not a second pass
over `targets` producing a duplicate of one), **data** (`steps.<name>.result`,
`resources.<name>.status.<field>`, `variables` / `secrets` / `ports`), and
**error** (a `throws:` union propagating along flow edges to the `catches:` arm
that discharges it). Data edges render inside an expanded body by default, and
across nodes on demand — selecting a resource shows what reads it.

### Collapse is per PROPERTY, and it hides a branch

The unit is a property, not a box. Collapsing a whole box said only "show less
of this", which on a canvas where every box is already drawn bought nothing —
the boxes stayed, the edges stayed, and the reader had put away a list they were
probably reading. What a reader wants to put away is a **branch**: the mounts of
a server, the steps of a sequence, the not-found handler — and with it
everything only that branch reaches.

- **Collapsible means it currently REACHES something.** A branch that reaches
  nothing — an unset slot, an array with no entries, a picked hold — hides
  nothing when collapsed, so the control would be a gesture with no effect and
  is not drawn at all; the row's first column goes to the label instead. It is
  the occupancy that decides, not the declaration: a `notFoundHandler` gains its
  chevron the moment something fills it and loses it again when cleared. A
  branch with no control is always drawn OPEN, in the geometry as well as the
  renderer — otherwise an empty ordered array could stay shut on a state key
  nothing can now clear, taking its "add" affordance with it.
- **A declaration written at a dispatch site is part of the body.** A slot may
  hold `invoke: { kind: …, …config }` rather than a name — 590 of the ~630
  runtime inline declarations in this repo sit at a step's `invoke:` — and the
  graph saw none of it: no node, no edge, and a step row identical to one that
  dispatches nothing. The references *inside* one were invisible too, so a
  connection reached only that way was reported as referenced by nothing and
  drawn as unwired. It is now one row for the declaration, named by the kind it
  declares and addressed at the site, and one row per reference it fills, each
  carrying a real edge. Rows rather than a label, because a reference needs
  somewhere for its line to leave from; and addressed at the site, because the
  declaration has no document of its own — clicking it opens the panel at that
  pointer, typed by the kind written there, which is the only way to edit one
  without first giving it a name. Neither kind of row is an ordered entry:
  nothing reorders a declaration, and removing it is an edit to its host's
  config rather than a splice.
- **A row says what KIND of statement it is.** Every line of a body read alike
  — a name and an arrow — so a `while` and a dispatch were indistinguishable and
  telling them apart meant opening the source. Each row carries the grammar
  branch it matches, in the schema's own words (`invoke`, `if/then/else`,
  `while/do`, `switch/cases/default`, `try/catch/finally`, `throw`, `value`),
  matched on the branch's REQUIRED keys — so a kind declaring a body of its own
  is described in the words its author chose and nothing knows that `while`
  exists. A step matching no branch (one just added, still empty) says nothing
  rather than guessing.
- **And what it turns on.** The expression deciding whether or how a statement
  runs — an `if:`, a `while:`, a `switch:`, a dispatch's `when:` guard, a boot
  target's — found through `x-telo-topology-role: predicate`, never by keyword,
  so a third-party composer annotating its own is read the same way. `when:` on
  the shared dispatch site is annotated as one for exactly that reason: it is
  the same fact a loop's condition is, and a surface showing what a step is
  conditional on should not have to know which word spelled it. A loop drawn
  without its condition states that it repeats and not until when, which is the
  whole behaviour.
- **A branch's rows are a TREE.** A step body nests, and the projection carries
  that nesting on every row, pre-order. Grouping rows by the concrete array each
  one sits in gave a `while`'s contents a branch of their own (`steps[1].do`)
  that no control on the box could reach: collapsing `Steps` hid the two
  top-level rows and left the loop's five statements on screen, under a label
  reading `2`. So a property owns its body at every depth, and each row that
  owns children carries its own control — putting a loop away takes its contents
  with it, at any depth, and the branch count stays the array's own length. A
  leaf keeps the column a chevron occupies, since siblings lining up is the whole
  readability of a tree. The row cap applies AFTER visibility, so shutting a long
  loop reveals what came after it.
- **A node disappears when everything that reached it is gone**: it has incoming
  edges, and every one of them either leaves a collapsed branch or comes from a
  node that has itself disappeared. That second clause is what makes collapsing
  put away the whole branch rather than its first step, and it is a fixpoint
  because hiding a node can be the last thing holding its own callees on screen.
- **A node nothing references stays** — an unwired declaration, a provider held
  only through a picked slot, the module root. Hiding those would let a
  collapse in one place silently remove a resource nobody linked to it.
- **A collapsed branch keeps its header line**, because that is what reopens it,
  and because a slot with no socket is a slot nothing can be wired into.
- **The canvas holds still.** The flow is one instance per module rather than
  one per expansion — keying it by the open branches tore it down on every
  toggle, restored a different pan and re-fitted, which was most of the jump.
  What remains is that a box changing height legitimately re-places its
  neighbours, so the viewport moves by exactly what the toggled box moved: the
  thing the reader just acted on stays where it was and the rest rearranges
  around it. A box in only one of the two layouts anchors nothing, since it has
  no "same place" to be held in.

### What is HELD is a drawer, not a box

Every relation reaching a connection, a store, a font or a named shape is a hold
or a type annotation, and the canvas draws neither: a hold collapses to the name
in its holder's picker, and a `shape` slot names a type with no runtime relation
at all. So these arrived as boxes with no line at either end, in a column of
their own, saying nothing a reader could not read off the holder — three of
three resources in one shipped library, a quarter to a third across the
examples. A named shape was worse: the referring slot is not on the rail either,
so `inputType: !ref SalesRows` appeared at *neither* end.

They keep their place in the editor, in **one drawer** listing everything the
module has that is not one of its own boxes — a reader asking "what else is in
here" asks it once, and a panel per category makes the answer depend on guessing
which panel a thing was filed under. Four groups, split by WHY a thing is not a
box: **Providers** and **Types** left the canvas because nothing draws a line to
them; **Kinds** and **Resources** are listed because they were declared in
another module — an imported kind has no instance here to draw, and an imported
instance is one this module reaches but did not write.

An array-valued picked slot adds and removes in place. Both writes already
existed — choosing a name on the trailing line appends, choosing "nothing" on a
filled one splices — but neither READ as add or remove: the trailing line
rendered exactly like a filled one, so the only thing marking "add another" was
an empty select at the bottom of a stack, and removal was a dash buried among
candidate names. Each line now says what it is: the appending one carries a `+`,
and an entry carries its own remove. **An array entry is not offered
"nothing"** — an array has no holes, so emptying one can only mean removing it,
and offering a word that does not apply is what made the operation invisible. A
single slot keeps it, where it genuinely means unset.

Selecting a row rings every box that reaches it — the ring is what stands in for
the line, read off EVERY edge rather than the drawn ones, since the collapsed
hold IS the question being asked. An imported kind rings the instances declared
of it. A module's own kinds are listed only when the drawer IS the canvas: a
module declaring kinds and no instances has no other surface, so withholding
them would leave it a blank panel.

**For an ambient hold the test is a drawn EDGE, not a capability**, and that is
what keeps the canvas connected: `Ai.Model` declares `capability: Telo.Provider`
and is genuinely called, so a line runs to it and it stays — removing by
capability would leave that line pointing at nothing. An owned declaration never
leaves either: it is drawn inside its owner and has nowhere else to be.

**An imported instance leaves unconditionally**, and that is a different rule for
a different reason. It is not this module's declaration: it is configured,
versioned and edited in the library that wrote it, so a box spends the canvas on
something offering none of a box's affordances — in a five-line application the
two `Console` handlers were two of its three boxes. What a reader wants of one is
its name and what reaches it, which is what the row and its ring say; the
reference itself is not lost, since a row states the name it dispatches to and a
held slot states the name it holds. It is filed under **Resources** whatever its
capability, so one instance does not change group according to whether something
happens to call it.

**An empty module still draws its root.** "No instance boxes" is not the same
claim as "this module's content is kinds": an empty application has no boxes
either, and conflating them handed the whole tab to a drawer with nothing to
list. The root box carries the boot list and the control that adds the first
target, which is where a new module is started from.

### Editing on the canvas

- **Create-and-wire at any outgoing site.** Two gestures, one surface: a `+`
  beside a socket (shown on hover, like a row's own controls), and a drag that
  ends on the canvas rather than on a box — which used to do nothing at all,
  silently. Both open the create-resource picker filtered to that slot's own
  accepted kinds, and both write the new resource and the reference in ONE
  workspace mutation, because two would race. The spread is what forced a real
  picker rather than a menu: most slots accept one kind, a boot target five to
  eight, and a step's `invoke:` twenty-odd in a real app — while two abstracts in
  the same app accept NONE, which is a message to write rather than an empty
  list. The name is the author's, since a picker that asks for one has to honour
  the answer. Position is the LAYOUT's, not the drop point: the layout is solved
  again on every edit, so a dropped position would survive exactly until the
  write that created it.
- **A socket is where a wire can START, and nowhere else.** A slot already
  holding a declaration written at the site cannot take one without destroying
  what is there, and a declaration row dispatches nothing of its own — its
  references are the rows beneath it. Neither draws one: a socket that can only
  refuse is the defect the rail exists to avoid.
- **One control per slot, naming the state it is in.** A slot offers `+` while
  it is empty and *empty this slot* once it is filled — by a reference or a
  declaration, since clearing is the same write either way. An "add" beside an
  occupied slot offers a gesture whose only meaning is "replace what is here",
  said by the wrong word. An array keeps its `+`, because it always has a next
  site; removing one of its items is the edge-delete gesture.
- **A declaration can be given a name.** The one operation that applies to a
  declaration and to nothing else: it moves to its own document and leaves a
  reference behind — one mutation, since a half-applied one is either a resource
  declared twice or a slot pointing at nothing.
- **A ROW is an outgoing site**, and it was not. A step's `invoke:` is declared
  on the step item schema, which sits behind a local `$ref` the reference field
  map deliberately never descends — so a sequence has no port for it, no handle
  resolved to a slot, and every drag from a step row was refused. Edges left
  those rows and none could be started from one. Each row now carries where its
  call is written and what may fill it, stated even when nothing fills it yet,
  because that is exactly the row an editor has something to offer at.
- **Add** appends an empty entry and stops there — no selection change, no
  panel. Adding a target is nearly always followed by wiring it, which happens
  on the new row; opening a form over it takes the reader out of the gesture
  they are in, and the row is one click away if they want it.
- **Delete an edge** clears the reference it came from, since an edge is not a
  thing of its own: it is a slot holding a name. An array item is spliced, a
  single slot cleared. A BOX is not deletable from the canvas — a declaration is
  removed where it is declared.
- **Selection is a change**, so a controlled canvas needs a handler for it or
  edges cannot be selected at all and the delete key has nothing to act on. A
  selected edge is also restyled explicitly, because every edge carries an
  inline colour for its class and that beats the default selected-edge rule in
  the stylesheet — selection was being applied and rendered invisibly, which
  reads as selection not working.
- The root's rows are its boot list and nothing else. `targets` carries the step
  grammar, so a call graph mints a step node for every entry that is not a bare
  `!ref`; rendering those beside the boot rows listed every inline target twice.

### Ordered arrays are declared, not observed

A box lists the arrays it CAN hold rows in — its entry lists, its step body, the
root's `targets` — whether or not any exist, for the same reason a port exists
when empty: a server with no mounts still has mounts, and a canvas that lists
only what is there offers no way to add the first one. It is also what decides
that a slot is row-owned, so a fresh server does not show a port and an add
control for the same list.

### Regions

Enclosures are drawn for the three relations that are genuinely containment —
inline ownership, `with:` scope, and execution zones — and for nothing else.
Reference reachability is not containment, which is what made a mount read as a
child of its server while its slot said `dependency`. A zone whose members are
contiguous in the layout gets a box; one whose members are not gets a badge and a
highlight-on-select, and says which it is rather than drawing a boundary that is
not there.

### Diagnostics

Diagnostics are **addressed to the same identities the canvas draws** — node,
port, row — which is the second reason the identity rule above has to exist:
a severity rollup on a box header, a marker on the exact port or row at fault,
and jump-from-diagnostic all resolve through one address space rather than a
per-surface lookup. The rollup is worst-severity plus count on the node header,
aggregating the interior when collapsed; file-scoped and unattributed
diagnostics land on the module root, so nothing is silently dropped. Jumping
works both ways — a diagnostic opens the canvas at its node, and a marked node
opens the source at its line.

### The kind plane

Kind declarations (§1.7) are a second plane, drawn with the same three
primitives but never mixed into the instance bands — a `Telo.Definition` is a
type, and placing it among the instances would put things that exist at runtime
and things that do not on one surface with nothing separating them.

- **A kind is a box** in a per-module **kinds drawer**, collapsed by default in
  a module that also declares instances, and *the* canvas in a kind-only module
  — `custom-kind`'s library renders this plane, not an empty canvas.
- **`extends` is its own edge class** within the plane: single-parent and
  transitive, drawn as lineage (child → ancestor), with `base:` shown as that
  edge's mapping the way `inputs:` is shown on a call edge. An abstract is a box
  marked non-instantiable; a concrete-`extends` child with no body shows it
  delegates.
- **A template body is the kind's interior** — its `resources:` entries are
  declarations of their own kinds and render as inline children exactly as an
  instance's do; `invoke:` / `run:` / `provide:` name the dispatched entry the
  way a step row names its target.
- **The two planes join at the instance's kind.** Selecting a kind highlights
  its instances and its `extends` descendants; a kind gated out of
  `exports.kinds` is marked, since that is what decides whether an importer may
  construct one.

### Scope: the graph spans module boundaries

The canvas is system-scoped, and three consequences follow.

**Node identity is module-qualified** — the alias path from the root, not the
bare name, since two libraries may each declare `routes`. The scale cost is
smaller than it appears: an imported library contributes nodes only if it
declares *instances*, and most of the standard library declares kinds only, so
`http-server`, `sql` and `run` contribute none. Path-imported libraries that own
instances are the real case, and they are the reason to do this at all — a root
of sixty lines wiring three libraries is otherwise three opaque leaves.

**A boundary is an edit boundary.** A workspace-local import is fully editable —
same ports, same drags, writes landing in that module's own file. A published
import is read-only, and the canvas says so at the point of the gesture rather
than dropping the write. This is a per-node fact in the model, not a UI check.

**Shared library singletons become visible structure.** `lifecycle: shared` is
one node several importers reach; `isolated` is one node per import declaration.
This is where the picture is honestly a DAG rather than a tree, and where an
expansion has to show one declaration seen from several places instead of copies.

### Layout: solved, not arranged

**Position and route are one problem, so one engine solves both** (ELK, layered,
orthogonal). Arranging boxes by hand and letting the renderer draw between them
failed in the two ways a picture of a real application fails: an edge leaving a
step ROW pointed at a box whose vertical position had nothing to do with that
row, and edges crossed whatever boxes lay between their ends.

What ELK is given is what makes it work:

- **Fixed ports** at the exact y each handle is rendered at, so an edge leaves
  its own row and the target is placed to suit. The geometry that says where a
  handle sits is shared with the renderer rather than restated, because a drift
  between the two is an edge that visibly starts somewhere other than its row.
- **Hierarchy** for owned declarations, so an inline child is laid out inside
  its owner by the engine rather than by arithmetic here.
- **Direction RIGHT**, so work reads left to right — the order the manifest
  reads in.
- **A shared resource is drawn ONCE and mirrored everywhere else.** A utility
  absorbs the picture: in `durable-orders` a `Console.WriteLine` takes 11 of the
  module's 22 lines and a `Timer.Delay` takes 4 — two boxes holding two thirds of
  the edges, every line crossing the canvas to reach them. Seven other shipped
  apps have nothing above three, so this is one shape going wrong rather than
  general clutter. The FIRST call site keeps the real edge to the real box; every
  later one gets a **mirror** beside the row that calls it, and the original
  carries `×N` so the count survives the lines that no longer show it. No
  threshold — the rule is "after the first", so nothing has to be true of a
  module for it to apply and there is no number at which the picture jumps.
  First means first REPORTED, which is declaration order: reading it off the
  layout is circular, since which copy is real decides which edges exist and the
  edges decide the layout.
- **A mirror carries a name and a kind and nothing else.** There is one resource
  with one configuration and one verdict from the checker; repeating those per
  call site is worse than the lines they replaced. It is sized as one LINE
  rather than as a box — given a header and a tail it stood four times taller
  than the row it answers to, so eleven ran three screens past the eleven that
  called them. Clicking one selects the original, and selecting the original
  rings every mirror of it, which is what replaces the lines for tracing.
  Mirrors are laid out by the SOLVER like any other node, one column past
  whoever calls them; placing them by hand would be a second layout mechanism
  running against ELK's.
- **A column is HOP DISTANCE from the way in, pinned rather than hoped for.**
  ELK's layering minimises total edge length, which answers a different
  question: it put a boot target three columns out from the application booting
  it, and a console handler three columns past the sequence calling it — both
  one hop away, both drawn as if deep in the chain. The ranks were already
  computed and never handed over; they are now the layer constraint, so two boot
  targets sit in one column, one above the other. Ranked over the edges the view
  DRAWS, because a column the reader can see no reason for is worse than no
  column.
- **One connected component**, or the partitions apply to nothing: separated
  components are packed after layout with no regard for a partition, which put a
  connection held only through collapsed chips — no drawn edge at all — in the
  leftmost column, ahead of the application that boots the work standing on it.
- **No infrastructure band.** It existed to pin providers and named shapes into
  a final column, and those are no longer boxes at all (see below). What ambient
  declaration remains on the canvas is one control genuinely transfers to —
  `Ai.Model` is called — and pinning THAT last contradicts the only thing a
  column means.

What stays ours is the meaning: which nodes exist, which edges are drawn, and
what each edge means. ELK decides geometry and nothing else. It is seeded, so
the same manifest lays out the same way every time — which is what makes "an
unrelated edit moves nothing" true. The solve is async, so the previous result
stays on screen while the next is computed and a stale answer never overwrites
a newer one.

**There is no ingress LANE, and there was one.** Entry points had a column of
their own, and it pulled whole chains into it — a server is a boot target and
the router it mounts declares the trigger — so a four-resource application that
reads as one left-to-right sequence was stacked into a vertical rail with its
edges routing back behind the boxes. Being a way IN is a property of a node, not
a place on the canvas: it is marked on the box, and the flow ranking already
puts it at the left, because nothing flows into it.

**The layout has a stated posture for every fact §8 allows to be missing.** A
node whose capability is unknown — an unresolved import, a kind with no schema —
goes to the **work surface with the unknown marker**, never to the pinned band:
a guess would move the node the moment the import resolves, and the work surface
is the one that claims nothing. A **Library** has no targets and registers no
triggers, so nothing flows into its exported instances and the ranking puts them
at the left by construction — which is also what renders when the library is
expanded in place, so a module reads the same opened directly or opened inside
its importer.

**Positions are derived, never authored.** They are solved from the graph and
the box geometry, so an unrelated edit moves nothing and a reorder in the YAML
is a visible move on the canvas. Collapse, expand and focus are the user's controls; there is no free
drag, because a hand-placed node is orphaned by the next manifest edit and there
is nowhere legitimate to persist it — the manifest is the source of truth and
carries no view state.

**Progressive disclosure, not modes.** Zoom decides density: far shows bands,
entry points and shared infrastructure; mid adds ports and flow edges; near
expands interiors into rows with their data flow. Expansion is per node and
sticky. Every layer is always present and the reader adjusts density — the
alternative, choosing which relation is currently real, is the mode flag that
produced six partial pictures.

### Where it lives

The **analyzer owns the projection**: nodes, typed edges and regions, folded over
the flattened analysis it already builds from the call graph, the reference field
map and the zone-containment walk. Three reasons, in order of weight: the
flattened analysis is what makes a cross-module edge an ordinary edge rather than
a special case; the fold is browser-safe, which the editor requires; and one
answer serves `telo check`, the editor and any later consumer instead of two
implementations drifting apart. The **studio owns the view**: bands, expansion,
labels, layout, gestures and write-back. No resource kind is named on either side
— placement comes from capability, `x-telo-*` annotations and the registry, so a
third-party kind renders exactly as `Http.Server` does.

### What this retires

The two containment views and their inferred tree are gone, replaced by real
regions. A route table and a step list are rows in a box on the module canvas.

**The canvas is never replaced.** A view used to be resolved per FOCUS, so
selecting a route or a step re-rooted the whole surface onto that resource's own
editor: the graph vanished, the panel changed under it, and the way back was a
breadcrumb the reader had to notice. Selecting a thing is a request to SEE it,
not to leave the picture it is in. So the focus path, the containment tree, the
breadcrumb, the view picker and the property rail are all gone — with them, the
only way the canvas could turn into something nobody asked for.

**The kind-declared editors live in the detail panel**, which is the surface
they were always right for: a body of twenty steps nested four deep is edited in
a list with drag affordances, and a canvas box is the wrong substrate for that
gesture — a drag inside a box competes with the canvas's own pan, and the two
are indistinguishable until one wins. The canvas carries reorder, remove and
argument editing for the rows it draws, as explicit controls for the same
reason. Following a call from either surface peeks; nothing navigates.

### Staging

Each stage is independently better than what ships today:

1. **Nodes, ports and edges — LANDED.** The three edge classes, the ownership
   classes, the identity rule, diagnostics rollup, and the infrastructure band.
   The projection is the analyzer's (`AnalysisRegistry.moduleGraph`), reached in
   the editor through `WorkspaceDiagnostics.moduleGraphByFile` — the same
   flattened manifest set the checker ran over, so a drawn node is a node the
   diagnostics are about. The canvas is the module root's view; the two
   containment views and their inferred tree are gone. Rows are emitted and
   rendered read-only, so a box shows what it runs; editing them is stage 2, and
   the kind-declared Steps / Entries / Routes canvases stay reachable at depth
   until it lands. `hasInterior` went with the containment views: with the whole
   module on one canvas, focusing is worth it only when the kind declares a
   canvas of its own.
2. **Interiors — LANDED.** Rows for step bodies and entry lists, with reorder,
   remove and per-row `inputs:` editing (typed by the target's declared
   contract, so the form and the checker agree). Inline and `with:`-scoped
   declarations are drawn INSIDE their owner as nested boxes — the first time
   either has been visible at all. Row identity is name-anchored, so a control
   acts on the row a reader pointed at even mid-edit.

   **The data plane did NOT arrive for free, and is not here.** A `Sql.Schema`'s
   tables are separate named resources it references — they are infrastructure
   boxes, not an interior — and a table's columns are an unannotated
   configuration map. Rows exist because a kind ANNOTATES an ordered list
   (`x-telo-topology-role: entries`, a step body); making columns rows would
   mean the editor knowing what a column is, which is the one thing it must not
   know. A column list belongs in the field form until some kind declares it as
   an entry list, and that is a change to `sql`, not to the canvas.
3. **Regions and overlays — LANDED.** Zone regions come from the containment
   walk the checker already uses (generalized to `findZoneProviders`, so a zone
   declaring no attributes is still found), drawn as a chip quoting the author's
   reason verbatim and a highlight over the members when the provider is
   selected. Data edges — `resources.<name>.status.<field>` — are parsed from
   CEL, never scanned, and drawn when the resource they concern is selected.
   Unwired markers say when nothing reaches a declaration; an imported export is
   never marked, since it is not the reader's to remove. Error paths are the one
   overlay still to build.
4. **Cross-module — LANDED.** An imported instance carries the alias it is
   reached under and is a drawer row rather than a box (see *What is HELD is a
   drawer*). A module whose files are not the workspace's is marked read-only and
   its rows offer no edit controls at all, rather than offering them and
   refusing. **Opening a library's interior in place is gone with the box that
   carried the control**; what replaces it is navigating into that module, and a
   drawer-side affordance for it is still to design.
5. **The kind plane — LANDED.** A drawer beside the canvas listing every kind
   with its capability, `extends` lineage, abstract / template / private
   markers, and the instances declared of it; selecting one highlights them.
   In a module that declares only kinds it is not a drawer but the canvas's own
   content, so a kind-only library no longer renders an empty picture.

### Error paths and wiring — LANDED

**What a resource can raise** is resolved through the same union `telo check`
validates a `catches:` block against, memoized across the graph, and carried on
the box (with `unbounded`, since a union that could not be closed statically
demands a catch-all). A row that DISCHARGES a code is marked by annotation, and
by **both** annotations that mark one — the shared CEL `x-telo-error-context`
and the dispatch vocabulary's `x-telo-outcome-list: catches`. Reading only the
first would have marked every route in the standard library as handling nothing,
which is the failure mode an annotation-driven rule is supposed to avoid.

**Drag-to-wire** validates against the slot's own `x-telo-ref`, expanded through
the registry, so the canvas cannot allow a wire the checker would reject and no
kind is named on either side. An array port carries an append handle, which is
how an item is added without typing a name first; the written reference is
alias-qualified when it crosses an import boundary and bare when it does not. A
constraint the registry cannot resolve **allows** the drop — an unresolved
import must not make every slot refuse every drop, which reads as a broken
editor rather than as an unresolved import, and the written reference is still
checked.

**A slot is filled by pointing at something as readily as by making something.**
The `+` beside a socket and a drag let go in empty space open one dropdown menu,
at the point the gesture was made; it used to be a create-only dialog, so the
commoner request — "call the resource I already have" — had no words in it, and
for an imported instance there is no answer at all now that it is not a box to
drop onto. The menu lists what is already declared and would fit, then the kinds
one could be created as. What it offers is the SAME rule the drag and a picked
slot's select use, so the three ways of filling one slot cannot disagree about
what fills it. It is anchored to a POINT rather than to a control, which is what
lets one menu serve both gestures: a drag ends wherever the reader let go, and
there is no element there to hang a trigger on.

**A site is several SPELLINGS, and which one is written follows from what was
picked.** A boot target takes a bare `!ref` to a `Telo.Runnable | Telo.Service`
and an invoke step whose `invoke:` takes any `Telo.Executable`; the projection
reported only the first, so every `Telo.Invocable` in an application was
unbootable from the editor — legal in the manifest, offered nowhere, which reads
as an empty module rather than as a missing site. A row's dispatch now carries
its alternatives, listed once per CONSTRAINT (a boot target's `ref:` accepts
exactly what its bare form does, so the two are one site and the plainer
spelling wins). A reader picks a resource and never a syntax: the reference
lands at whichever spelling accepts its kind.

**A row opens the ENTRY it stands for, not its host and not its target.** A boot
target, a mount, a route, a step is a line of its host's configuration carrying
its own — a guard, an argument map, a retry budget, a path and a method — so
clicking it opens the panel at that entry's own pointer. Selecting the host
answered a question the reader did not ask (the whole body, with the one line
they clicked somewhere inside it); selecting the RESOURCE at the far end answered
a different one, which its own box already answers, and could not be answered at
all for an imported instance, whose declaration is not in this module's view
data. The entry always is.

**The union is resolved by the VALUE, never offered as a choice.** A boot target
is a union — a bare reference, a gated `ref:`, an invoke step — and so is the
shared step grammar. Which one an entry IS follows from what is written there,
and the analyzer already answers that for the kernel (`selectUnionBranch`), so
the panel and the runtime cannot disagree about which branch a value was written
against; offering the choice instead would put a variant picker in the form and a
second answer to the same question. A row the form cannot render in full falls
back to the host rather than mis-rendering: an entry written as a bare reference
(no configuration, and the panel edits an object body), an entry no branch fits,
and a schema still carrying a reference — a control-flow step, whose arms are
arrays of the recursive step grammar. The form resolves no references, so drawing
one would put a text box where a list of statements belongs.

**A kind is written in its DECLARING module's alias scope.** A library declares
its own instances as `kind: Self.WriteLine`, and `Self` means that library;
carried into a flattened application the spelling survives and resolves to
nothing there. Every consumer joining on a kind therefore missed a whole imported
library at once — which slots accept it, which instances a kind has, what schema
a form uses — with no diagnostic, because the two names simply never matched. The
projection resolves the kind in the module that wrote it and carries the answer
as `canonicalKind`; consumers join on that, and none of them re-resolves, since
the entry module's scope is the one scope where a `Self.` spelling means
something else.

**A row-owned port answers through its rows.** It draws no socket and no `+` —
its occupancy is the rows of the array it sits in — so both of its paths belong
to a row, and resolving one at the port is what made a boot target's `+` find
the bare-reference constraint and lose the entry's other spellings with it. A row
is designated two ways, by its own handle (what a drag leaves from) and by its
dispatch path (what a `+` beside it reports), and both mean the one site.

### The identity collapse — FIXED

The call graph keyed a resource by `(kind, name)`, which is unique inside one
module and **not** across a flattened set: two libraries each exporting an
`Http.Api` named `routes` collapsed onto one node, the second overwriting the
first and taking its edges and steps with it. Identity now carries the declaring
module wherever the loader stamped one, so a manifest that never crossed a
boundary keeps the bare form and nothing else moves.

The half that made it a real fix rather than a rename: **a bare `!ref <name>`
now resolves in the module that WROTE it**, which is what the name means — a
cross-module reference is written with an alias. A name declared in exactly one
module still resolves from anywhere, so every single-module load behaves as it
did; a name declared in several other modules and none of the reader's resolves
to nothing, because guessing between them would attribute a call to a resource
the author never named. Verified on `url-shortener`: both `routes` boxes now
carry their own two rows and their own outgoing edges.
