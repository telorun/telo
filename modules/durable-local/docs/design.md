# Why durable-local is shaped this way

The reasons behind choices the manifest only names.

## The workflow carries its steps

`Local.Workflow` holds `steps:` itself rather than pointing an `invoke:` at a separate sequence. That is a safety property, not a convenience: a named body is a body anything can invoke directly — running unjournaled steps up to its first wait, through an edge no static check can see. With the grammar built in there is no second resource to misuse. It is also the one kind that holds a body, installs the run handle and drives replay; every other kind addresses a run from outside.

Its zone is marked durable by the `replayed` attribute alone. Keying the static checks on the bare providing annotation would apply them inside every transaction, and keying them on a kind name would put this module into the analyzer's surface.

## No observed state on the workflow

Observed state is illegal before a resource has started, and an Invocable is never marked started, so the workflow cannot report any. A workflow also serves many runs at once, so one slot of state could only report whichever run finished last. A run's observations — collapsed regions, replayed steps — are written on its own record and read back by `Local.Result`; the workflow's output is a start acknowledgement, declared closed so a manifest cannot read an outcome off it.

## The journal is this backend's, not a shared abstract

The journal lives in this module rather than in a module of its own: a standalone `journal` module would collide with `record-stream`'s `Journal` kinds on name, alias and hub search, and it is one backend's mechanism — a hosted engine has no journal to configure, so a shared abstract would be a contract most backends implement by leaving it empty.

What makes a journal work is not storing rows but claiming due runs without two resumers taking the same one, and waking promptly. That is why a store implements this contract rather than a key/value store being reused: `KvStore.Store` is point-access only, and widening it to answer a range query would weaken a contract other modules rely on.

## `onConflict` is in this backend's words

Each engine's policy for a taken run id has states of its own, and a shared three-value enum was a lossy translation of all of them, so this backend spells its own: `attach` or `reject`.
