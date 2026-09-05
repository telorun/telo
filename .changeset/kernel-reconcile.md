---
"@telorun/kernel": minor
---

`Kernel.reconcile()` brings a running kernel into line with an edited manifest,
rebuilding only what moved. Resources whose declarations are unchanged keep their
instances — a connection stays open, a server keeps its socket, a cache keeps
what it has accumulated.

`load()` is split to make it possible. Producing manifests — loading the graph,
validating it, flattening it, normalizing inline resources — is the half that can
run again; building the context, the built-in definitions and the injection hooks
happens once per kernel. `reconcile()` re-produces against the existing context,
after dropping every file of the previous graph from the loader's cache, which
memoizes a file's parse on the assumption its contents do not change underneath
one Loader — exactly what a reload breaks.

What then happens is the diff, the impact closure and the partial unwind meeting:
the declarations that moved are unwound together with everything transitively
holding them, deregistered, re-registered from the new set, and re-initialized.
Unwinding runs consumer-first and initialization dependency-first, both from the
same edges, so a rebuilt resource's holder is torn down before it and rebuilt
after it.

**Six changes are reported rather than narrowed**, with nothing unwound, and
`restartRequired` says which. A module other than the entry moving, because the
runtime manifest set is entry-only — an imported library's resources live in the
child context its `Telo.Import` owns and never reach the diff. An
application-document change, because `variables` / `secrets` / `ports` /
`logging` resolve once for the whole application. A `Telo.Definition` or
`Telo.Abstract` change, because kind registration is once per kernel — the
registry only ever adds, so the previous registration would survive and the
running kernel would enforce a weaker contract than `telo check` does against the
same file. The application document being IN the impact set — it holds its own
`targets:` and `logging.sinks`, so the closure reaches it whenever one moves, and
it is the one resource nothing here can rebuild: only `installManifests`
re-applies the targets, metadata, environment and logging it carries. A resource
in the impact set that was resolved by NAME, whose holders are unknown. And a resource that has already been RUN: boot targets run once, so
re-initializing one would leave it constructed and idle — a server listening on
nothing — while reporting it as rebuilt. The caller rebuilds the kernel, which is
what it does for every edit today.

Declaration signatures are taken **at load time**, because the kernel registers
the very manifest objects it loaded and resolving a reference writes a live
instance into one. A signature taken at reconcile time renders those slots opaque
and reports a change that never happened — on the application document, whose
`targets:` hold resolved references, that meant escalating every reconciliation
there is.

A failure after the unwind raises `ERR_RECONCILE_FAILED` naming what is already
gone: the resources cannot be rolled back to a state that no longer exists, so
the kernel is degraded and must be rebuilt. Only the `restartRequired` returns
promise that nothing was touched. The context's initialization window is opened
and closed through its own methods, in a `finally`, so a failed pass cannot leave
it half-open — which would turn every later lookup into a deferral with no pass
coming.

`EvaluationContext.deregisterManifest(name)` is the inverse of `registerManifest`
this needed: unwinding disposes the instance, and this clears everything keyed by
the name so the same name can be declared again. Without it a second load hit
`ERR_DUPLICATE_RESOURCE`, which is the right answer for a manifest declaring one
name twice and the wrong one for the same manifest read again. It clears the
withheld and created-instance records too — a resource left withheld would be
skipped by the init loop for the life of the kernel.

`telo run --watch` and the runner's watch sessions still rebuild a whole kernel
per edit; wiring them to this is separate.

Two kinds of edge feed the closure. A reference slot, and a CEL read: a
compile-eval field is expanded and baked in at create time, so `!cel
"resources.db.dsn"` leaves no reference behind and a reader whose provider was
rebuilt would have kept serving the previous load's value with nothing reporting
it. Read edges are captured from the declaration, through the same extraction the
module graph draws its `data` edges with. Unwinding a resource now also drops its
published reading, so an expansion that would otherwise find a stale value defers
until the provider is back — which is what a fresh boot does.

`produceManifests` writes the kernel's static half as it goes, so every exit
before installation restores it. Without that, a caller told to restart held a
kernel whose graph, manifest set and signatures had already moved, and a second
reconcile diffed the new set against itself and reported no change while the live
instances were the originals. Reference validation and cycle detection now run
BEFORE the unwind, since both are pure over manifests plus registry and running
them after converts a detectable condition into a degraded kernel. Overlapping
calls are refused rather than interleaved.
