---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
---

**Resource inputs on a library** — a `Telo.Library` gains a third input block
beside `variables:` and `secrets:`, declaring the instances it requires from
whoever imports it. The importer supplies references at the import's object form
(`resources: { connection: !ref db }`).

Instances used to flow up and never down: `exports.resources` hands one to an
importer, and nothing handed one the other way. Each import declaration also
builds its own child module context with its own instances, so two libraries
importing a third get two of everything in it — measured, an application
importing two libraries that each import one library owning a SQLite connection
fails with `no such table`, because the writer and the reader are on different
connections. Any set of libraries that must share a resource therefore had to be
linearized into a total order with every layer re-exporting the union of
everything beneath it, which gives away the self-containment a split is for. It
is a correctness constraint rather than a preference: a journal attests
exactly-once only when it writes on the same connection as the work it records.

- **An entry is constrained by KIND, with no `use:`.** The boundary is a
  dependency edge for init order whatever the library does with the instance, so
  the token would carry nothing the edge model reads — and the flattened
  application analysis drops the library doc, so an app-level claim about
  internal call sites is one nothing could check.
- **An entry synthesizes a kind-only DECLARATION in the library's own scope**, so
  `!ref connection` at a reference slot and `resources.connection.<field>` in CEL
  answer exactly as they do for a locally declared resource. Kind-only is enough
  because it is already what a reference slot gets: the `status:` half types from
  the kind and the flat half stays open.
- **Borrowed, not owned.** An injected resource's effect frame belongs to the
  scope that declared it, so the child context never tears it down. Its published
  reading is mirrored into the library's own `resources` scope on every
  publication, because a reading is not a snapshot — the owner republishes after
  `run()`, after every `invoke()` and on every `setStatus()`.
- **Diagnostics**: `RESOURCE_INPUT_KIND_UNRESOLVED` at the library that declared
  the constraint; `RESOURCE_INPUT_MISSING`, `RESOURCE_INPUT_UNKNOWN`,
  `RESOURCE_INPUT_UNRESOLVED` and `RESOURCE_INPUT_KIND_MISMATCH` at the import
  that supplied (or failed to supply) it. Kind acceptance is the same transitive
  rule an ordinary reference slot applies, shared rather than re-derived.
- **Two declaration-derived checks move to the injection site**, where the real
  declaration is: a projection through an injected input reports nothing at the
  library (a new `injected` projection-failure reason), and
  `OBSERVED_STATE_NEVER_RUN` treats an injected name as reachable, since a
  library cannot answer whether its consumer starts what it was handed.
- **Init order** falls out of the existing graph: a `Telo.Import` gains a
  dependency edge per injected target — to a local resource, or to the import
  that exports a cross-module one, which is the projection
  `localDependencyNames` already makes at runtime. A cycle among those is
  reported as a cycle; one closing through an imported instance still surfaces
  as an init-loop failure, since nothing connects a forwarded export back to its
  owning import. An import whose target is not yet initialized defers with
  `ERR_LOCAL_REF_PENDING` before doing any load work, and binding a borrowed
  instance is an EFFECT on the create frame — it registers a publication mirror
  on the owner, and an import whose `init()` fails is discarded and re-created,
  so an unregistered mirror would be appended again on every pass.
- **An input name listed in `exports.resources` is `RESOURCE_INPUT_EXPORTED`.**
  An input is borrowed, so exporting it would forward the kind-only stand-in into
  the consumer's flattened set as a resource the library declares — a phantom
  with nothing behind it but a kind constraint.

New syntax on a module document, so a module using it must declare
`requires: telo: ">=…"`. Guide: `docs/extend/library-resource-inputs.md`.
