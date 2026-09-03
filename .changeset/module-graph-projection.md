---
"@telorun/analyzer": minor
"@telorun/studio": minor
---

Add the module graph — the projection an editor draws a module from.

`AnalysisRegistry.moduleGraph(manifests, { root, entryModule })` folds the call
graph, the reference field map, the zone-containment walk and each kind's own
schema into what a picture needs:

- **Boxes** — every resource, whatever declaration form it arrived in (named,
  inline, `with:`-scoped, imported, injected), plus the module root.
- **Rows** — the ordered entries inside one: steps, entry-list items, boot
  targets, each carrying where its call resolved and where its arguments are
  written.
- **Edges** — classed by what happens at the site: `flow` for the four control
  transfers, `holds` for `dependency`, `shape` for `schema`, and `data` for a
  CEL read of another resource's published state, which no slot declares and the
  reference graph cannot carry.
- **Regions** — the three genuine containments: inline ownership, `with:`
  scopes, and execution zones (with the attributes each guarantees and the
  author's reason verbatim).
- **Kinds** — the second plane: every `Telo.Definition` / `Telo.Abstract` with
  its lineage, whether it is abstract, whether it carries a body of its own, and
  the instances declared of it.
- **Error contracts** — what invoking a resource can raise, resolved through the
  same union `telo check` validates a `catches:` block against, plus a marker on
  the rows that discharge one.

Three properties the previous editor-side model did not have:

- **Declared-but-empty ports.** A slot is a port whether or not anything fills
  it, so an unwired `notFoundHandler` is visible — and fillable — rather than
  absent.
- **Name-anchored identity.** A step keeps its identity when a sibling is
  inserted above it; an unnamed entry is keyed by what matches it, never by its
  index.
- **Module-scoped resource identity.** A resource name is scoped to its module,
  so `(kind, name)` was never unique across a flattened set: two libraries each
  exporting an `Http.Api` named `routes` collapsed onto one call-graph node, the
  second overwriting the first and taking its edges and steps with it. Identity
  now carries the declaring module wherever the loader stamped one (a manifest
  that never crossed a boundary keeps the bare form), and a bare `!ref <name>`
  resolves in the module that WROTE it — a name declared in exactly one module
  still resolves from anywhere, while an ambiguous one resolves to nothing
  rather than being guessed. `!ref <Alias>.<name>` resolves to the instance it
  names.

`findZoneRegions` is now a filter over a new `findZoneProviders`, so a consumer
wanting regions regardless of the attributes they declare — an editor drawing
the enclosure — no longer has to enumerate the attribute vocabulary and silently
miss whatever is not in it.

The editor's Topology tab renders it as one canvas, laid out and routed by ELK
(layered, orthogonal, fixed ports): an edge leaves the exact row that declares
it and goes around the boxes in its way, rather than starting at an arbitrary
point on its source and crossing whatever lies between. Work reads left to
right with infrastructure partitioned last, owned declarations nested inside
their owner, row-level reorder / remove / argument editing where a write can
land, and a kinds drawer that becomes the whole canvas for a module that
declares only kinds. It replaces the two containment views,
which drew a tree inferred from reference reachability: a relation the manifest
does not have, which put a mounted router "inside" its server on the strength of
a `use: dependency` slot and gave a shared resource one parent per referrer.

The canvas is also never replaced now. A view used to be resolved per focus, so
selecting a route or a step re-rooted the topology tab onto that resource's own
editor and the graph vanished; the kind-declared editors (Routes, Steps,
Entries, Fields) render in the detail panel beside the graph instead, and
following a call from either surface peeks rather than navigates. The focus
path, containment tree, breadcrumb, view picker and property rail go with it.

**A body is a tree, and a declaration written at a dispatch site is part of it.**
A slot may hold `invoke: { kind: …, …config }` rather than a name, and the graph
could see none of it: no node, no edge, and a step row identical to one that
dispatches nothing — 590 of the ~630 runtime inline declarations in this repo
sit at a step's `invoke:`. Worse, the references *inside* one were invisible
too, so a connection reached only from inline declarations was reported as
referenced by nothing and drawn as unwired.

`GraphRow` now carries two further kinds. An **`inline`** row stands for the
declaration, named by the kind it declares (`declares`, plus `unknownKind` when
that kind resolves to nothing) and addressed at the site, so an editor can open
and edit it where it was written. A **`reference`** row stands for each
reference the declaration fills, and carries a real `GraphEdge` — which is what
puts the hold back on the graph, and why these are rows rather than a label: a
reference needs somewhere for its line to leave from. Both nest recursively.
`isOrderedRow(row)` says which rows are positions in an array, so a consumer
offering reorder or removal asks rather than assuming: a declaration borrows its
host's `array` to group into the right branch and has no sibling to be moved
past. `StepGraphNode.refSlots` records the sites, because a step array's
items sit behind a local `$ref` that the reference field map deliberately never
reaches, and the step walk is the only place a step's schema and its value are
both in hand.

The editor draws that tree: rows of a body group under the top-level field at
every depth, and each row that owns children carries its own control. Grouping
by the concrete array each row sits in had given a `while`'s contents a branch
of their own that no control could reach — collapsing `Steps` hid the two
top-level rows and left the loop's five statements on screen under a label
reading `2`.

**An ambient hold is picked, not wired.** A slot whose `use` is `dependency` and
whose constraint resolves only to `Telo.Provider` / `Telo.Type` draws a select
over the names that may fill it instead of a socket, a chevron and a static
name — the same acceptance rule a drag onto that slot obeys, plus `New <Kind>`
where nothing of the kind exists yet. A branch that reaches nothing loses its
collapse control entirely, since collapsing it would hide nothing.

**A column is hop distance from the way in.** ELK's layering minimises total
edge length, which answers a different question — on the agent template it put a
boot target three columns out from the application that boots it, and a console
handler three columns past the sequence that calls it, both one hop away. The
ranks were already computed and never handed over; they are now the layer
constraint, ranked over the edges the view actually draws. Layout is also one
connected component, or the partition applies to nothing: separated components
are packed afterwards with no regard for it, which put a connection held only
through collapsed chips — no drawn edge at all — in the leftmost column, ahead
of the application, instead of last with the rest of the infrastructure.

**What is HELD is a drawer, not a box.** Every relation reaching a connection, a
store, a font or a named shape is a hold or a type annotation, and the canvas
draws neither — so these arrived as boxes with no line at either end, in a
column of their own, saying nothing a reader could not read off the holder
(three of three resources in one shipped library; a quarter to a third across
the examples). A named shape was worse: the referring slot is not on the rail
either, so `inputType: !ref SalesRows` appeared at neither end. A shape has no
runtime instance, so it is listed with the kinds; a provider is an instance, so
it gets a drawer of its own, with its held-by count and its diagnostics.
Selecting either rings every box that reaches it. The test for leaving the
canvas is a drawn EDGE rather than a capability, which is what keeps the picture
connected: `Ai.Model` declares `capability: Telo.Provider` and is genuinely
called, so it keeps its box and its line. With them gone the infrastructure band
goes too — it existed to pin exactly those, and a column now means only how far
along the flow a box sits.

One drawer beside the canvas lists everything the module has that is not one of
its own boxes, in four groups split by why: **Providers** and **Types** (off the
canvas, because nothing draws a line to them), **Kinds** and **Resources** (both
imported — declared in another module). Selecting any of them rings every box
that reaches it.

**An imported instance is a drawer row, not a box**, and unlike an ambient hold
that does not turn on whether a line reaches it. It is not this module's
declaration — it is configured, versioned and edited in the library that wrote
it — so a box spends the canvas on something offering none of a box's
affordances; in a five-line application the two `Console` handlers were two of
its three boxes. An edge into one is summarised at its source the way a hold is,
so a row still states the name it dispatches to and a held slot still states the
name it holds. It is filed under **Resources** whatever its capability, so one
instance does not change group according to whether something happens to call
it.

**Create-and-wire at any outgoing site.** `GraphRow.dispatch` states where a
row's call is written and what may fill it — a step's `invoke:`, an entry's
`handler:`, a boot target — present even when nothing fills it yet. A step's
slot is declared on the step item schema, behind a local `$ref` the reference
field map never descends, so it reaches the row through `StepGraphNode.refSlots`
(which now records every declared slot, filled or empty, replacing the
inline-only list). That closed a gap in the editor as well: nothing resolved a
step row's handle to a slot, so edges left those rows and no drag could be
started from one. `RefWrite` gains `createName`, so a picker that asks for a
name can honour it. The editor offers a `+` beside each socket and the same
thing on a drag that ends on the canvas, both opening one dropdown menu at the
point of the gesture: what is already declared and would fit, then the kinds one
could be created as. What it offers is the same rule the drag and a picked
slot's select use, so the three ways of filling one slot cannot disagree about
what fills it.

**Clicking a row opens the ENTRY it stands for** — the boot target, mount, route
or step itself, at its own pointer — rather than its host resource or the
resource at the far end. An entry carries the configuration a reader came for
(`when:`, `inputs:`, `retry:`, a route's `path` and `method`), it is always in
this module's own YAML, and the resource it dispatches to already has a box.
Which shape the entry IS comes from the analyzer's own `selectUnionBranch` (now
exported alongside `collectProperties`), so the panel and the runtime agree about
which branch a value was written against. A row whose entry the form cannot
render in full — a bare reference, an entry no branch fits, or a control-flow
step, whose arms are arrays of the recursive step grammar the form cannot follow
— falls back to selecting its host rather than drawing a text box where a list of
statements belongs.

**A kind is resolved in the module that WROTE it**, and `GraphNode.canonicalKind`
carries the answer. A library declares its own instances as
`kind: Self.WriteLine`, where `Self` means that library; flattened into an
application the spelling survives and resolves to nothing, so every consumer
joining on a kind missed a whole imported library at once — which slots accept
it, which instances a kind has, what schema a form uses — with no diagnostic,
because the two names never matched. The kind plane keys its instance lists on it
too.

**A dispatch site is several SPELLINGS**, and `GraphRow.dispatch.alternatives`
carries them. A boot target takes a bare `!ref` to a
`Telo.Runnable | Telo.Service` and an invoke step whose `invoke:` takes any
`Telo.Executable`; reporting only the first made every `Telo.Invocable` in an
application unbootable from an editor — legal in the manifest, offered nowhere.
They are listed once per CONSTRAINT: a boot target's `ref:` accepts exactly what
its bare form does, so the two are one site and the plainer spelling wins. A
reader picks a resource and never a syntax; the reference lands at whichever
spelling accepts its kind.

`GraphRow.dispatch` also reports whether the slot is already occupied by a
declaration written at the site, which is what lets a consumer tell the two
states apart: a socket is drawn only where a wire could start, so an occupied
declaration and the declaration row itself draw none; the slot offers `+` while
empty and *empty this slot* once filled (the same write for a reference and a
declaration); and a declaration additionally offers the one operation that
applies to nothing else — moving to its own document, leaving a reference
behind.

**A row says what KIND of statement it is, and what it turns on.** Every line of
a body read alike — a name and an arrow — so a `while` and a dispatch were
indistinguishable without opening the source. `GraphRow.variant` carries the
grammar branch the step matches, in the schema's own words, matched on the
branch's required keys rather than a keyword list; `GraphRow.predicate` carries
the expression it turns on, found through `x-telo-topology-role: predicate`. The
shared dispatch site's `when:` is annotated as a predicate for that reason — it
is the same fact a loop's condition is — which also gives a gated boot target
its guard, where before it read as running always.

**A shared resource is drawn once and mirrored everywhere else.** A utility
absorbs the picture — in `durable-orders` one `Console.WriteLine` takes 11 of
the module's 22 drawn edges — while seven other shipped apps have nothing above
three. The first call site keeps the real edge; every later one gets a mirror
beside the row that calls it, sized as one line, carrying a name and a kind and
nothing else, with `×N` on the original. No threshold: the rule is "after the
first". Mirrors are laid out by the solver like any other node, one column past
whoever calls them.

An array-valued picked slot adds and removes in place: the appending line
carries a `+` and each entry carries its own remove. An array entry is no longer
offered "nothing" — an array has no holes, so emptying one can only mean
removing it — while a single slot keeps it, where it means unset.

