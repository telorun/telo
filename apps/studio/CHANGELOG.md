# @telorun/studio

## 0.16.0

### Minor Changes

- 7ddd502: Add the module graph — the projection an editor draws a module from.

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
  sit at a step's `invoke:`. Worse, the references _inside_ one were invisible
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
  empty and _empty this slot_ once filled (the same write for a reference and a
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

### Patch Changes

- Updated dependencies [7ddd502]
- Updated dependencies [8dc6e35]
  - @telorun/analyzer@0.69.0
  - @telorun/ide-support@0.18.1

## 0.15.1

### Patch Changes

- Updated dependencies [d887374]
- Updated dependencies [c15b198]
  - @telorun/analyzer@0.68.0
  - @telorun/ide-support@0.18.0

## 0.15.0

### Minor Changes

- d5b8228: Watch sessions: a session can now be a workspace that runs continuously instead
  of one run. One pod holds a shared `/workspace` volume, a `workspace` container
  serving the editor's file routes, one container per application under `telo run
--watch`, and optionally a co-resident agent from the operator's app catalog — so
  an edit costs a kernel reload rather than a pod. Off unless
  `RUNNER_WATCH_SESSIONS` is set; run sessions are unchanged.

  Session status and run outcome become two nouns on one stream. `status` is the
  session's (`starting`/`running`/`suspended`/`stopped`/`failed`), while a new `run`
  event carries one application's generation — so a one-shot Runnable finishing
  leaves the session alive and the next edit starts the next generation. `run`
  events are projected from the kernel debug stream rather than parsed out of a
  terminal, and the CLI now emits `Kernel.RunFailed` for the one case that stream
  did not carry: a manifest that fails to load at all.

  Breaking, and the ripple is the reason the version moves rather than the size of
  it: `RunnerFeatures.io` becomes a list of attach modes; `progress`, `debug`,
  `reachability` and the byte channel are qualified by application (`/io` takes
  `?app=`, and every binary frame gains a stream tag); and the `stdout` / `stderr`
  `RunEvent` variants are deleted — nothing ever emitted them, so they were a
  contract in shape only. Workload output travels the byte channel, as it always
  did in practice.

  `@telorun/debug-wire` gains no code — its README now writes down the four kernel
  events a HOST derives behaviour from (`Kernel.Starting`, `Kernel.Stopped`,
  `Kernel.RunFailed`, `Kernel.PortsResolved`) and the requirement that a stream
  with a replay buffer carry a monotonic `id:` and honour `Last-Event-ID`. The
  dotted event vocabulary is otherwise open; these four are the exception because a
  kernel that omits them leaves a runner with no run outcomes and no way to
  re-route a port, so a second runtime needs them written down.

  The CLI also honours `CLICOLOR_FORCE` for Node's colour libraries, bridging it
  onto `FORCE_COLOR` when that is not already set — one variable now reaches a
  Rust, Go or Node workload alike, and `FORCE_COLOR=0` beside `CLICOLOR_FORCE=1`
  keeps its meaning.

### Patch Changes

- Updated dependencies [7d49da2]
- Updated dependencies [46295b2]
- Updated dependencies [46295b2]
- Updated dependencies [46295b2]
- Updated dependencies [d5b8228]
  - @telorun/analyzer@0.67.0
  - @telorun/sdk@0.83.0
  - @telorun/templating@0.18.0
  - @telorun/debug-wire@0.4.1
  - @telorun/ide-support@0.17.1
  - @telorun/debug-ui@0.6.3

## 0.14.0

### Minor Changes

- b9c0dbe: Renamed Telo Editor to Telo Studio. The app moved to `apps/studio`, the package
  is `@telorun/studio`, the desktop bundle is `telo-studio` with identifier
  `com.telo.studio`, and the web build now deploys to `studio.telo.run` (releases
  to the `telorun/studio` repo, tagged `studio-v*`).

  Two consequences for existing users. The desktop app's new bundle identifier
  makes it a distinct application: an installed Telo Editor will not update to
  Telo Studio and both can be installed side by side.

  Browser storage keys were renamed to a `telo-studio:<area>[:v<N>]` scheme. A
  one-time migration at startup moves every key written under the old name, in
  both stores — `localStorage` for workspaces, history, deployments, the run
  index, settings and agent conversations, and `sessionStorage` for the per-tab
  run resume cursors — so nothing is lost on upgrade. A key that cannot be
  rewritten (an exhausted quota) is reported to the console and retried on a
  later start; readers treat their own missing key as "no persisted state", so a
  partial migration degrades rather than corrupts.

### Patch Changes

- Updated dependencies [cbc2a4d]
- Updated dependencies [68aa6dc]
- Updated dependencies [c829d25]
- Updated dependencies [c829d25]
- Updated dependencies [b9c0dbe]
- Updated dependencies [c829d25]
- Updated dependencies [c829d25]
- Updated dependencies [c829d25]
  - @telorun/analyzer@0.66.0
  - @telorun/ide-support@0.17.0
  - @telorun/templating@0.17.0
  - @telorun/sdk@0.82.1

> Released as `telo-editor` / `@telorun/editor` through 0.13.17.

## 0.13.17

### Patch Changes

- Updated dependencies [ffe8ca5]
- Updated dependencies [67cafc0]
- Updated dependencies [ffe8ca5]
- Updated dependencies [6dd29e6]
  - @telorun/analyzer@0.65.0
  - @telorun/ide-support@0.16.1
  - @telorun/sdk@0.82.0
  - @telorun/templating@0.16.0

## 0.13.16

### Patch Changes

- Updated dependencies [d267c7f]
- Updated dependencies [839fb45]
  - @telorun/sdk@0.80.0
  - @telorun/analyzer@0.64.0
  - @telorun/ide-support@0.16.0
  - @telorun/templating@0.16.0

## 0.13.15

### Patch Changes

- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [321f153]
- Updated dependencies [321f153]
- Updated dependencies [b5dc9d5]
- Updated dependencies [18a5d61]
- Updated dependencies [c7fdbd9]
- Updated dependencies [7463386]
- Updated dependencies [c7fdbd9]
- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [9ac2b8a]
- Updated dependencies [321f153]
  - @telorun/sdk@0.79.0
  - @telorun/analyzer@0.63.0
  - @telorun/ide-support@0.15.0
  - @telorun/debug-ui@0.6.2
  - @telorun/templating@0.16.0

## 0.13.14

### Patch Changes

- Updated dependencies [afb2b05]
  - @telorun/analyzer@0.62.1
  - @telorun/ide-support@0.14.1

## 0.13.13

### Patch Changes

- Updated dependencies [17584a7]
- Updated dependencies [17584a7]
- Updated dependencies [987decd]
- Updated dependencies [d08c3bd]
  - @telorun/analyzer@0.62.0
  - @telorun/ide-support@0.14.0
  - @telorun/sdk@0.77.0
  - @telorun/templating@0.16.0

## 0.13.12

### Patch Changes

- Updated dependencies [f4efb4b]
  - @telorun/analyzer@0.61.0
  - @telorun/ide-support@0.13.3

## 0.13.11

### Patch Changes

- Updated dependencies [831c0c4]
- Updated dependencies [58bc988]
  - @telorun/sdk@0.75.0
  - @telorun/analyzer@0.60.0
  - @telorun/templating@0.16.0
  - @telorun/ide-support@0.13.2

## 0.13.10

### Patch Changes

- Updated dependencies [ccf56f5]
- Updated dependencies [35e1a58]
  - @telorun/sdk@0.74.0
  - @telorun/analyzer@0.59.0
  - @telorun/templating@0.15.0
  - @telorun/ide-support@0.13.1

## 0.13.9

### Patch Changes

- Updated dependencies [a434722]
- Updated dependencies [c8d457b]
  - @telorun/analyzer@0.58.0
  - @telorun/templating@0.14.0
  - @telorun/ide-support@0.13.0
  - @telorun/sdk@0.73.0

## 0.13.8

### Patch Changes

- Updated dependencies [55a7bef]
- Updated dependencies [e801bd2]
  - @telorun/templating@0.13.0
  - @telorun/analyzer@0.57.0
  - @telorun/ide-support@0.12.0
  - @telorun/sdk@0.72.0

## 0.13.7

### Patch Changes

- 51d7156: Imports view re-pins an upgraded import instead of announcing it dropped the pin.

  The hub reports an integrity pin per version on `GET /module/versions`, and `fetchHubVersions` already parsed it — the Imports view then discarded it in three places, mapping every response down to bare version names and rewriting the source with `withRefVersion` alone, which sheds the fragment pin. Every upgrade therefore came out unpinned, with a banner telling the user to run `telo upgrade` to recover what the editor was holding all along. The VS Code lens had done this correctly since it landed; the editor's model/AST path never picked it up.

  Upgrading now folds the target version's published pin into the new source, so an already-pinned import stays pinned and an unpinned one gains a pin — the same outcome `telo upgrade` produces. The banner survives for the case it was written for: the hub publishes no hash for the version being moved to.

  Where the pin lands follows the shape the author wrote. An entry with an `integrity:` sibling keeps it (its value is replaced in place); everything else carries a `#sha256-…` fragment on the source. `ParsedImport` gained `integrity` so the sibling form is visible at all — an object-form pin previously read as "not pinned", so it was deleted silently, with not even the banner to show for it.

- Updated dependencies [0ea1b8b]
- Updated dependencies [0ea1b8b]
  - @telorun/sdk@0.70.0
  - @telorun/analyzer@0.56.1
  - @telorun/templating@0.12.0
  - @telorun/ide-support@0.11.3

## 0.13.6

### Patch Changes

- Updated dependencies [8cede51]
  - @telorun/analyzer@0.56.0
  - @telorun/ide-support@0.11.2

## 0.13.5

### Patch Changes

- Updated dependencies [2373398]
- Updated dependencies [2373398]
  - @telorun/sdk@0.68.0
  - @telorun/analyzer@0.55.0
  - @telorun/templating@0.12.0
  - @telorun/ide-support@0.11.1

## 0.13.4

### Patch Changes

- Updated dependencies [8a9b494]
- Updated dependencies [0938ed4]
  - @telorun/sdk@0.67.0
  - @telorun/analyzer@0.54.0
  - @telorun/ide-support@0.11.0
  - @telorun/templating@0.12.0

## 0.13.3

### Patch Changes

- Updated dependencies [3bd2de9]
  - @telorun/analyzer@0.53.0
  - @telorun/ide-support@0.10.1

## 0.13.2

### Patch Changes

- Updated dependencies [bd6398e]
- Updated dependencies [f94ff85]
- Updated dependencies [0bbbc3f]
  - @telorun/ide-support@0.10.0
  - @telorun/analyzer@0.52.0
  - @telorun/sdk@0.65.0
  - @telorun/templating@0.11.1

## 0.13.1

### Patch Changes

- Updated dependencies [c28ee72]
- Updated dependencies [424aacf]
- Updated dependencies [642b057]
  - @telorun/ide-support@0.9.0
  - @telorun/analyzer@0.51.0
  - @telorun/sdk@0.64.0
  - @telorun/templating@0.11.1

## 0.13.0

### Minor Changes

- 3e9f802: Surface outdated `imports:` entries in the IDE, the way the telo editor's Imports view already does.

  `@telorun/analyzer` gains `newestModuleVersion(versions, { includePrerelease })` beside `isNewerModuleVersion`. Both halves of an upgrade check have to come from one rule: a host that decides "behind" through the shared ordering but reads "latest" off the head of a version list is answering with whatever order its index happened to return. For a module whose newest tag is a prerelease, list-order said the import was behind while the ordering rule said it was current — the same manifest against the same hub, two answers. Unparseable tags (an OCI digest, a moving `latest`) are dropped rather than ordered, and prereleases are excluded unless asked for, matching `telo upgrade`'s default. The editor's Imports view now derives its "latest" through it, so its badge no longer offers `-rc` builds as automatic upgrade targets; the per-import dropdown still lists every version for a deliberate pick.

  `@telorun/ide-support` gains `buildImportUpgrades(text, listVersions, docs?)` — a host-neutral builder that locates every `imports:` entry of a module document, asks a caller-supplied `ModuleVersionLookup` for each distinct base ref's versions, and returns the source edits that re-point the ones that are behind. Both authored shapes are handled: for the object form the now-stale `integrity:` line is deleted alongside the source rewrite, because the pin hashes the `telo.yaml` of the version being replaced and carrying it forward would turn the next install into a tamper error. An entry whose pin shares a line with other fields is reported as a skip — carrying its anchor and versions, so a host renders it in place of the upgrade affordance rather than showing nothing for an import that is behind.

  The VS Code extension renders it as CodeLenses: a summary lens on the `imports:` key (`2 imports outdated · Upgrade all`), a per-entry lens (`↑ 0.9.0 → 1.0.0`), and a warning lens for a skip. Version lists come from the hub, memoized so lens resolution stays off the keystroke path — failures are memoized too, on a shorter clock, or an unreachable hub would fire a request per base ref on every keystroke. A click that changes nothing now says which of the three reasons applied: a lookup that failed, a skip that named a reason, or genuinely current. Hub failures go to a new `Telo` output channel, reachable from the failure notification. New setting `telo.importUpgrades.enabled` turns the feature and its hub traffic off; new command `Telo: Check Imports for Updates` drops the memo and re-checks.

  `@telorun/cli` drops its private copy of the module-kind list in favour of the analyzer's `isModuleKind`.

### Patch Changes

- Updated dependencies [e52a2bf]
- Updated dependencies [e52a2bf]
- Updated dependencies [3e9f802]
  - @telorun/analyzer@0.50.0
  - @telorun/sdk@0.63.0
  - @telorun/ide-support@0.8.0
  - @telorun/templating@0.11.1

## 0.12.7

### Patch Changes

- Updated dependencies [15acf14]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
  - @telorun/analyzer@0.49.1
  - @telorun/sdk@0.62.0
  - @telorun/ide-support@0.7.10
  - @telorun/templating@0.11.1

## 0.12.6

### Patch Changes

- Updated dependencies [bf324d2]
- Updated dependencies [2ee3598]
- Updated dependencies [bf324d2]
  - @telorun/sdk@0.61.0
  - @telorun/analyzer@0.49.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.9

## 0.12.5

### Patch Changes

- Updated dependencies [d23de89]
  - @telorun/analyzer@0.48.0
  - @telorun/sdk@0.60.0
  - @telorun/ide-support@0.7.8
  - @telorun/templating@0.11.0

## 0.12.4

### Patch Changes

- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
  - @telorun/analyzer@0.47.0
  - @telorun/sdk@0.59.0
  - @telorun/ide-support@0.7.7
  - @telorun/templating@0.11.0

## 0.12.3

### Patch Changes

- Updated dependencies [8353d0e]
  - @telorun/sdk@0.58.0
  - @telorun/analyzer@0.46.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.6

## 0.12.2

### Patch Changes

- Updated dependencies [3729559]
  - @telorun/analyzer@0.45.0
  - @telorun/ide-support@0.7.5

## 0.12.1

### Patch Changes

- Updated dependencies [f3b044d]
  - @telorun/analyzer@0.44.0
  - @telorun/sdk@0.56.0
  - @telorun/ide-support@0.7.4
  - @telorun/templating@0.11.0

## 0.12.0

### Minor Changes

- 89bb36d: Add starter templates and hub-backed import search.

  Starter templates: a curated set (fetched over http(s), not bundled) offered on
  first run and when creating a module, via a shared dialog — pick a name, then a
  template or blank. Add-import now searches the telo hub and guards against
  silently clobbering an existing import alias.

### Patch Changes

- Updated dependencies [942c176]
- Updated dependencies [adc8459]
- Updated dependencies [adc8459]
- Updated dependencies [adc8459]
  - @telorun/sdk@0.54.0
  - @telorun/analyzer@0.43.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.3

## 0.11.15

### Patch Changes

- Updated dependencies [de6c2aa]
  - @telorun/analyzer@0.42.0
  - @telorun/ide-support@0.7.2

## 0.11.14

### Patch Changes

- Updated dependencies [ab4a911]
  - @telorun/templating@0.11.0
  - @telorun/analyzer@0.41.1
  - @telorun/ide-support@0.7.1

## 0.11.13

### Patch Changes

- Updated dependencies [0c1c8fd]
- Updated dependencies [2e1bb5c]
  - @telorun/analyzer@0.41.0
  - @telorun/ide-support@0.7.0

## 0.11.12

### Patch Changes

- Updated dependencies [bdc21e9]
  - @telorun/ide-support@0.6.0

## 0.11.11

### Patch Changes

- Updated dependencies [6418e2a]
  - @telorun/analyzer@0.40.0
  - @telorun/ide-support@0.5.0

## 0.11.10

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/sdk@0.50.0
  - @telorun/analyzer@0.39.0
  - @telorun/debug-wire@0.4.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.45
  - @telorun/debug-ui@0.6.1

## 0.11.9

### Patch Changes

- Updated dependencies [2395a4a]
  - @telorun/sdk@0.49.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1

## 0.11.8

### Patch Changes

- Updated dependencies [8af345f]
- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/sdk@0.48.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.44

## 0.11.7

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0
  - @telorun/sdk@0.47.0
  - @telorun/ide-support@0.4.43
  - @telorun/templating@0.10.1

## 0.11.6

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/analyzer@0.36.0
  - @telorun/ide-support@0.4.42

## 0.11.5

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0
  - @telorun/ide-support@0.4.41

## 0.11.4

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1
  - @telorun/ide-support@0.4.40

## 0.11.3

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/analyzer@0.34.0
  - @telorun/sdk@0.44.0
  - @telorun/ide-support@0.4.39
  - @telorun/templating@0.10.1

## 0.11.2

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.38

## 0.11.1

### Patch Changes

- Updated dependencies [2ff9027]
  - @telorun/analyzer@0.32.0
  - @telorun/ide-support@0.4.37

## 0.11.0

### Minor Changes

- 721a241: Retire the Tauri-native local Docker runner in favor of a **local runner supervisor**: the desktop editor now runs the published `telorun/docker-runner` image as a local container (pinned to the docker-runner version built from the same commit; `latest` in dev) and talks to it through the standard http-runner adapter, so local runs gain everything the `/v1` contract carries — progress phases, per-port reachability, capabilities, session re-attach, and the authoring agent (`OPENAI_API_KEY` is forwarded from the host environment when present).

  Starting the runner is an explicit user action: availability reports can now carry an adapter-provided **action** (`AvailabilityAction`), rendered as a "Start local runner" button — with its consequences spelled out — in the run panel's unavailable banner and the runner settings row; a "Stop local runner" control tears it down. Nothing boots implicitly: not on launch, not on probe, not on Run. On editor quit the runner container and its bundle volume are removed (workload sessions stop with it).

  Persisted `tauri-docker` runner instances migrate in place to the new `local-docker` adapter (`image`/`pullPolicy` carry over; the remote-daemon `dockerHost` option is dropped — point a docker-runner at a remote daemon and add it as an HTTP runner instead).

### Patch Changes

- Updated dependencies [721a241]
  - @telorun/sdk@0.41.0
  - @telorun/analyzer@0.31.0
  - @telorun/templating@0.10.0

## 0.10.3

### Patch Changes

- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0
  - @telorun/ide-support@0.4.36

## 0.10.2

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1
  - @telorun/ide-support@0.4.35

## 0.10.1

### Patch Changes

- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/analyzer@0.30.0
  - @telorun/ide-support@0.4.34

## 0.10.0

### Minor Changes

- 897c0b9: Surface session port reachability on the endpoint badge instead of the log stream.

  After a session goes running, the runner (`watchReachability` in
  `@telorun/runner-core`, used by the k8s and docker backends) probes each declared
  tcp port and emits a structured `reachability` `RunEvent` per port — `checking`,
  then `reachable`, or `unreachable` after a 30s timeout (flipping back to
  `reachable` if it recovers). The editor renders this on each endpoint link in the
  debug panel: a spinner while checking, a green icon when reachable, a red icon
  when unreachable — turning the loopback-bind / wrong-port failure (previously an
  opaque downstream 502, or a late log line) into live status on the URL itself.

  The badge reflects reachability from the runner to the workload (pod network for
  k8s, published port / container for docker) — a proxy for the common loopback-bind
  failure, not end-to-end health of the public link, and a startup signal rather
  than continuous monitoring (a port that comes up then dies keeps its green icon).

### Patch Changes

- 897c0b9: Run controls: the top-bar Run button now becomes a Stop button while a run is
  live (one control, same slot) instead of showing a separate Stop or an
  always-present Run that restarts; the run-panel Stop is removed. Also adds an
  inline "Clear" action on the recent-runs dropdown header to clear finished run
  history — a still-live run is kept so it isn't orphaned.
- Updated dependencies [897c0b9]
  - @telorun/debug-ui@0.6.0

## 0.9.0

### Minor Changes

- 506fc90: Surface analyzer diagnostics across the editor: each overview-graph node (and
  Providers & Types strip entry) now shows a severity dot + count with a
  severity-colored border, and side-pane form fields surface the diagnostics whose
  path falls under them. The Source tab carries the module's diagnostic badge, and
  a preview notice sits above the graph canvas noting that visual editing is still
  incomplete.

### Patch Changes

- 506fc90: Publish Tauri desktop binaries (macOS, Windows, Linux) as GitHub Releases on
  each editor release, source the bundle version from package.json, and align the
  dialog plugin's npm package with its Rust crate.

## 0.8.14

### Patch Changes

- ac76b1f: Publish Tauri desktop binaries (macOS, Windows, Linux) as GitHub Releases on
  each editor release, and source the bundle version from package.json.

## 0.8.13

### Patch Changes

- Updated dependencies [ebca26a]
- Updated dependencies [d84a585]
  - @telorun/analyzer@0.29.0
  - @telorun/glob@0.2.0
  - @telorun/ide-support@0.4.33

## 0.8.12

### Patch Changes

- Updated dependencies [a9ac4ba]
- Updated dependencies [a125804]
- Updated dependencies [a125804]
  - @telorun/sdk@0.38.0
  - @telorun/analyzer@0.28.1
  - @telorun/debug-ui@0.5.0
  - @telorun/debug-wire@0.3.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.32

## 0.8.11

### Patch Changes

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0
  - @telorun/ide-support@0.4.31

## 0.8.10

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/sdk@0.36.0
  - @telorun/analyzer@0.27.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.30

## 0.8.9

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0
  - @telorun/ide-support@0.4.29

## 0.8.8

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/sdk@0.34.0
  - @telorun/analyzer@0.25.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.28

## 0.8.7

### Patch Changes

- Updated dependencies [95f168e]
- Updated dependencies [95f168e]
  - @telorun/sdk@0.33.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.8.6

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/sdk@0.32.0
  - @telorun/debug-wire@0.2.0
  - @telorun/debug-ui@0.4.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.8.5

### Patch Changes

- Updated dependencies [b41012f]
- Updated dependencies [b41012f]
  - @telorun/debug-ui@0.3.0
  - @telorun/sdk@0.31.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.8.4

### Patch Changes

- Updated dependencies [b1dd65c]
- Updated dependencies [0c16f41]
  - @telorun/debug-ui@0.2.1
  - @telorun/templating@0.10.0
  - @telorun/analyzer@0.24.1
  - @telorun/ide-support@0.4.27

## 0.8.3

### Patch Changes

- Updated dependencies [aaa760d]
- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0
  - @telorun/templating@0.9.0
  - @telorun/ide-support@0.4.26

## 0.8.2

### Patch Changes

- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2
  - @telorun/debug-wire@0.1.0
  - @telorun/debug-ui@0.2.0
  - @telorun/ide-support@0.4.25

## 0.8.1

### Patch Changes

- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1
  - @telorun/ide-support@0.4.24

## 0.8.0

### Minor Changes

- e6e8d88: Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
  endpoint. Runners advertise their own editable config schema; the editor
  collapses the docker-api and k8s adapters into a single capability-driven
  http-runner adapter with managed add/edit/remove/switch runners, and preflights
  required variables/secrets before a run.

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/sdk@0.26.0
  - @telorun/analyzer@0.23.0
  - @telorun/templating@0.8.0

## 0.7.8

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.7.7

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.7.6

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0
  - @telorun/sdk@0.23.0
  - @telorun/templating@0.7.0
  - @telorun/ide-support@0.4.21

## 0.7.5

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0
  - @telorun/ide-support@0.4.20

## 0.7.4

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/sdk@0.21.0
  - @telorun/analyzer@0.19.1
  - @telorun/ide-support@0.4.19

## 0.7.3

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/ide-support@0.4.18

## 0.7.2

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/sdk@0.19.0
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.7.1

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/sdk@0.18.0
  - @telorun/ide-support@0.4.17
  - @telorun/templating@0.4.1

## 0.7.0

### Minor Changes

- 125aeec: Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a manifest over HTTP (e.g. a GitHub raw URL) and copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml` for local editing. Relative (same-origin) imports cascade — their files are fetched and persisted verbatim, mirroring their layout relative to the root (without escaping the workspace) — while registry imports continue to resolve via the configured registry adapters. Before anything is written, a confirmation dialog previews the application/library name, description, declared imports, and the exact list of files to be created (flagging overwrites). A toast confirms the import. `loadWorkspace` now also resolves local imports that point at non-`telo.yaml` files copied in by a cascade.
- 3dc20d0: Add a Kubernetes runner. Extract backend-neutral `@telorun/runner-core` from docker-runner (shared `/v1` contract, routes, registry, SSE, ring buffers) behind a `RunnerBackend` seam; docker-runner becomes a thin backend over it with no behaviour change. Add `@telorun/k8s-runner`, a `KubernetesBackend` that runs Telo apps as sandboxed Pods (attach-based PTY, hard-ceiling limit clamping, tokenized bundle delivery, per-session ingress, orphan reaping) plus a Helm chart (RBAC, quota, NetworkPolicy) and a CI image job. Add a k8s editor `RunAdapter` via a shared `createHttpRunnerAdapter` factory. Rename the docker image `telorun/telo-runner` → `telorun/docker-runner`.
- e9c73ed: Add a raw file explorer and unified open-editors tabs. The left sidebar now shows the full workspace file tree (create/rename/delete/drag-move, with selection driving where new files land and top-level folders expanded by default), backed by a new `rename` workspace-adapter primitive across the Tauri, File System Access, and localStorage backends. The center pane is now a VSCode-style tab strip: module tabs host the structured views while non-telo files open in a Monaco editor (binary files show a placeholder). Open tabs, the active tab, and expanded folders persist across reloads, and structural file ops re-scan the workspace so the Applications/Libraries view stays in sync. Imports, Definitions, Resources, and Kinds moved from the sidebar/Inventory into dedicated module-view tabs (Imports keeps add/remove and the version-upgrade dropdown); the Inventory view and the redundant file-path/module-path labels were removed.

## 0.6.0

### Minor Changes

- 10868cd: Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a single manifest over HTTP (e.g. a GitHub raw URL), copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml`, and opens it for local editing. If a module with the same slug already exists, the user is prompted to confirm an overwrite via an alert dialog. A toast confirms a successful load.

### Patch Changes

- 69a0a8d: Align the telo-editor's static-analysis projection with the CLI's import boundary. Extract `flattenForAnalyzer`'s local/foreign forwarding rule into a shared `selectModuleManifestsForAnalysis` helper so the editor and the CLI cannot drift, and have the editor apply it per closure: the closure root stays fully local while imported modules forward only their definitions/abstracts/imports plus `exports.resources` instances (flagged `forwardedExport`). The editor now also anchors a closure at every workspace-local module (not just Applications), so a library imported by an app is validated in its own scope instead of the consumer's. Fixes cross-module `!ref Alias.export` (e.g. a flat `targets` invoke step) reporting spurious `SCHEMA_VIOLATION` / `UNDEFINED_KIND` in the editor while passing `telo check`.
- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/ide-support@0.4.16

## 0.5.4

### Patch Changes

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.5.3

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/ide-support@0.4.14

## 0.5.2

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/sdk@0.17.0
  - @telorun/ide-support@0.4.13
  - @telorun/templating@0.4.1

## 0.5.1

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/sdk@0.16.0
  - @telorun/templating@0.4.1
  - @telorun/ide-support@0.4.12

## 0.5.0

### Minor Changes

- d187abd: Add the module overview graph as the `Telo.Application` topology canvas. Opening
  an Application now lands on a node-and-edge graph of its resources: nodes are
  partitioned by capability (Application / Service / Invocable / Runnable / Mount),
  ref relationships render as labelled edges, and ambient Provider / Type sources
  render as a collapsible side strip with "uses" chips on the resources that
  reference them. Layout is deterministic via `@dagrejs/dagre`; rendering via
  `@xyflow/react`.

  The module root is exposed through a synthesized kind + resource adapter, so
  selection, lookup, and the PickCanvas topology dispatch route it through the same
  path as every other resource. Opening a module default-selects its overview
  graph; the detail panel shows a read-only root summary (targets / variables /
  secrets). The graph replaces the sidebar's resource list — the sidebar's
  resources section is removed and the create-resource action moves onto the canvas
  as a panel button.

  `Telo.Library` modules get the exact same overview canvas (shared adapter,
  topology dispatch, renderer, and model). A Library has no `targets`, so it gets
  no target edges, no drag-to-wire, and no Targets section in the detail body;
  everything else — resource nodes, Provider/Type strip, ref edges, create
  button — is identical.

  Edges and chips are derived from the analyzer's `buildOverviewGraph` /
  `visitManifest`, so no resource kind is hardcoded in the editor. Refs nested
  inside step bodies (e.g. `Run.Sequence` `steps[].invoke`) are surfaced via the
  visitor's `discoverNestedRefs` value-tree scan, so resources used only from
  inside a sequence no longer render detached.

  Sequence-like nodes render their internal topology: a node whose kind schema
  declares an `x-telo-topology-role: steps` field shows its steps as sub-rows, each
  with its own source handle. Discovery recurses through branch / case / loop
  bodies and flattens them into a depth-indented row list, so the invokes inside a
  `while/do` loop appear individually instead of collapsed onto the loop. Each edge
  anchors to the deepest step its ref `fromPath` falls under — so a multi-step
  `Run.Sequence` shows one edge per `steps[].invoke` instead of bundling onto the
  node's outer handle. Step discovery is annotation-driven (shared with the
  Sequence canvas's variant helpers), so no kind name is hardcoded. A post-layout
  pass aligns each node's vertical center with the handle it is wired from — a step
  row for a per-step invoke edge, otherwise the source node — sweeping ranks
  left-to-right so a downstream ref target follows its already-aligned source
  (dagre has no per-handle ordering). Edges run roughly horizontal instead of
  crossing.

  The overview canvas's pan/zoom is remembered per module: the viewport is keyed by
  module filePath in editor state and restored when navigating back to an app/lib
  (fitting only on first view), instead of being shared across all modules.

  The selected node is highlighted on the overview canvas, and pressing Delete /
  Backspace on a selected non-root node removes that resource (new
  `removeResourceViaAst` AST op). The module root is never deletable, and the key
  handler is ignored while a text input is focused.

  Targets are editable directly on the graph: dragging an edge from the
  Application node to a Runnable / Service adds a target, deleting a target edge
  removes one. Endpoint validity is enforced against the kernel rule (targets must
  be `Telo.Runnable` or `Telo.Service`). Targets are read and written as `!ref
<name>` sentinels — the canonical reference form; the graph normalizes the
  sentinel shape when matching edges. Writes go through a new manifest-root
  `setApplicationTargets` AST op — distinct from the resource AST path because the
  Application root lives on the document root, not in `manifest.resources`.

### Patch Changes

- a6a1b96: feat(editor): edit variables/secrets on the app/library node detail panel

  Selecting the application/library node now renders an editable variables/secrets
  form (reusing the schema form) instead of a read-only summary. The form branches
  on the module kind: Application entries are host env bindings (`env` + `type`),
  while Library entries are plain JSON-Schema declarations (no `env`). Each entry's
  fields render inline in a horizontal row via a `flat` prop on the schema-form
  components (an editor layout choice, not a schema annotation), so `type`/`env`
  are visible without expanding a per-entry accordion.

  The module root is written through the generic `setResourceFields` (resolved via
  an owner-doc fallback), retiring the bespoke `setApplicationTargets`;
  `diffFields` now treats tagged `!ref`/`!cel` sentinels as opaque leaves so
  reference arrays like `targets` round-trip without losing their tags.

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@1.0.0
  - @telorun/analyzer@1.0.0
  - @telorun/templating@1.0.0
  - @telorun/ide-support@0.4.11

## 0.4.0

### Minor Changes

- a41e69a: Rework run handling to support one session per application with per-application
  run history. Starting a second run no longer crashes the editor with a blank
  screen (`RunIo.open() may be called only once`): a per-run terminal buffer now
  owns the single transport open and replays its transcript into the view, so runs
  stay re-viewable across remounts. The Run button gains a chevron dropdown listing
  the active application's recent runs; selecting one opens its output.

### Patch Changes

- bfe4967: Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
  (sibling of `variables` / `secrets`) where each entry binds a host env var to
  an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
  typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
  mirroring the variables env-resolution path, with the same
  `ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
  `ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
  a single declared source. A runner or the editor can read the exposed ports
  (and the env var that configures each) before the app starts. Application-only;
  `Telo.Library` does not declare ports.

  Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
  port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
  nominal CEL type, and a resource field can declare which brand it accepts
  (`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
  `TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
  the value flows as a plain integer at runtime, so there is no runtime cost.

  Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
  `ports` entry that no CEL expression references is flagged (a generic,
  table-driven pass across the three namespaces). Application-only — a
  `Telo.Library`'s `variables` / `secrets` are a controller-consumed public
  contract and are not flagged.

- 4815295: Isolate each application's static analysis so apps in a workspace no longer
  interfere with one another. Previously the whole workspace was analyzed against
  a single shared registry keyed by module name, so when two apps imported the
  same library at different versions, one version's definitions overwrote the
  other's — producing spurious diagnostics and wrong completions for the losing
  app. Analysis now runs per-application closure with an isolated registry, and
  the source-view completion provider selects the registry of the active module.
  Diagnostics are also now routed to each resource's own source file via the
  analyzer's stamped `filePath`, so two modules that legitimately share a
  `{kind, name}` (resource names are module-scoped) no longer misattribute one
  module's diagnostics to the other.
- 1c37ee1: Add `visitManifest` — one shared manifest visitor that emits the annotation
  sites (`RefSite`, `ScopeBoundary`, `SchemaFromSite`, `CelSite`, plus resource
  enter/exit bookends) the analyzer's passes previously each rediscovered with
  duplicated scaffolding. `validate-references`, `dependency-graph`, and the CEL
  context walk now consume it; behaviour is unchanged (full analyzer + integration
  suites pass).

  Path-driven sites (ref / scope / schema-from) come from the per-kind field map;
  CEL sites are found by scanning the value tree, with the field map supplying the
  matched `x-telo-context`. Scope is per-resource: `ScopeBoundary` carries both the
  source-enclosure prefixes (for ref candidate scoping) and the enclosed-resource
  name set (for dropping boot edges to scoped targets), so no cross-resource
  ordering or global state is needed.

  Exposes `AnalysisRegistry.visitManifest` as the public host seam, and adds the
  editor `buildOverviewGraph` adapter that projects `RefSite` events into
  capability-classified edges (Service/Invocable/Runnable/Mount) and "uses" chips
  (Provider/Type).

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1
  - @telorun/ide-support@0.4.10

## 0.3.5

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/ide-support@0.4.9

## 0.3.4

### Patch Changes

- Updated dependencies [c0129c0]
  - @telorun/analyzer@1.5.0
  - @telorun/ide-support@0.4.8

## 0.3.3

### Patch Changes

- Updated dependencies [0331069]
  - @telorun/analyzer@1.4.0
  - @telorun/ide-support@0.4.7

## 0.3.2

### Patch Changes

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]
  - @telorun/analyzer@1.3.0
  - @telorun/templating@1.1.0
  - @telorun/ide-support@0.4.6

## 0.3.1

### Patch Changes

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]
  - @telorun/analyzer@1.2.0
  - @telorun/ide-support@0.4.5

## 0.3.0

### Minor Changes

- 39aef08: `Telo.Application` accepts `variables:` / `secrets:` with per-field `env:` mapping; values resolve at `kernel.load()` into the root `variables.X` / `secrets.X` CEL scope before any controller or import initialises. `type:` supports `string | integer | number | boolean | object | array` — object and array values are JSON-decoded from a single env var. Coercion / schema / missing-required failures aggregate into one `ERR_MANIFEST_VALIDATION_FAILED` at load.

  `Telo.Library` variables / secrets remain pure JSON Schema property maps. An `env:` key on a Library entry is now rejected at load time with a `LIBRARY_ENV_KEY_REJECTED` diagnostic that explains importers must supply the value.

  The Telo editor's Deployment tab now renders the Application's declared environment contract above the free-form env vars list, so authors see exactly which env vars the manifest binds. The tab still drives the existing Run feature's env wiring — no manifest mutation.

  `Config.Env` is deprecated in favour of the new Application-level shape. The kind continues to work; the controller logs a deprecation notice at init and the docs page is marked deprecated. Migrating consumers is recommended but not forced.

  Diagnostics that target a missing child property now squiggle just the parent key identifier instead of the whole value block. `buildPositionIndex` additionally records map keys under the `@key:<path>` namespace, and the IDE range resolver prefers that key range when the leaf path isn't indexed.

### Patch Changes

- Updated dependencies [39aef08]
  - @telorun/analyzer@1.1.0
  - @telorun/ide-support@0.4.4

## 0.2.12

### Patch Changes

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/sdk@1.0.0
  - @telorun/analyzer@1.0.0
  - @telorun/ide-support@0.4.3
  - @telorun/templating@1.0.0

## 0.2.11

### Patch Changes

- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.2.10

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1
  - @telorun/templating@0.2.3
  - @telorun/ide-support@0.4.1

## 0.2.9

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/analyzer@0.10.0

## 0.2.8

### Patch Changes

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.2.7

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/templating@0.2.1
  - @telorun/ide-support@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/templating@0.2.0
  - @telorun/ide-support@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0
  - @telorun/ide-support@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/ide-support@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0
  - @telorun/ide-support@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/analyzer@0.5.0
  - @telorun/ide-support@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0
  - @telorun/ide-support@0.2.1

## 0.2.0

### Minor Changes

- 2900b1c: Added port exposure to the Run feature. The Deployment view has an "Exposed ports" editor next to "Environment variables"; both the in-process Tauri Docker adapter and the remote `@telorun/docker-runner` HTTP service publish the configured ports (`-p port:port/protocol` / Docker API `PortBindings`) when a session starts. The Run view header shows one clickable `host:port` chip per exposed port; the host is resolved from `DOCKER_HOST` (Tauri adapter) or from the runner's base URL (HTTP adapter). `RunStatus.running` now carries an optional `endpoints` array describing where the container is reachable.
- 9391cba: Added per-module undo/redo for source edits. Every persisted edit (from the form views, topology canvas, or Monaco source view) is recorded as a snapshot on a per-module history stack, keyed by the module's owner file path. The top bar has Undo / Redo icon buttons that walk the active module's stack; consecutive edits to the same file within 1s are coalesced into a single entry, each module caps at 20 entries, and the stack is persisted to `localStorage` scoped by workspace root so history survives across sessions. Monaco's built-in in-buffer undo is untouched and runs orthogonally.

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/ide-support@0.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/analyzer@0.2.1

## 0.1.5

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/analyzer@0.2.0

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/sdk@0.2.6
