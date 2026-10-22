# Host-path conformance vectors

What a kernel refuses when it creates a resource holding a `Telo.HostPath`, frozen as data: both kernels read `vectors.json` and answer each row identically, word for word. Editing one expected message breaks every runner until each implementation says it.

Two refusals, checked in this order over the resource's whole configuration:

1. `ERR_HOST_PATH_ENTRY_MISMATCH` — an absolute path at a slot declaring `entry: file | directory` that exists as the other kind of entry. A path naming nothing is accepted: whatever uses it may create it.
   `ERR_HOST_PATH_UNREADABLE` in its place when the filesystem answers neither what is there nor that nothing is (a permission refused, a name too long).
2. `ERR_HOST_PATH_RELATIVE` — a relative path at a host-path slot. Text a union accepts beside the path (`":memory:"`) is not a path.

## Format

`vectors.json` is one object, `{ "schema": …, "rows": [ … ] }`. `schema` is the configuration schema of the kind every row creates a resource of. Each row:

- `id` — unique, `<outcome>/<case>`.
- `value` — the resource's configuration.
- `code` — the refusal, or `null` when the value is accepted.
- `message` — the refusal's text after the resource's label, exactly; `null` when accepted.

`{file}`, `{directory}`, `{absent}` and `{unreadable}` in a value or a message stand for absolute paths in a fresh directory: an existing regular file, an existing directory, a path naming nothing, and a name of 300 characters, longer than a POSIX filesystem accepts. Windows reports such a name as absent and has no portable path it will not answer for, so a runner there skips the rows using `{unreadable}`. `{reason}` in a message is the operating system's reason, which each runtime words its own way: any non-empty text matches it. A kernel raises a refusal with the message `<Kind>/<name>: <message>`.

## Runners

- `kernel/nodejs/tests/host-path-conformance.test.ts` — the Node kernel's creation-time checks.
- `kernel/rust/src/host_paths.rs` (tests) — the Rust kernel's.

A relative literal never reaches the Node kernel's creation-time check: the analysis it runs at load refuses it first (`HOST_PATH_RELATIVE`). The Rust kernel runs no analysis, so for a literal this row is the refusal it raises.

A row holds at most one refusal of each kind: the Node kernel walks an object's keys in the order they were written and the Rust kernel in sorted order, so which of two would be reported first is not pinned.

The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
