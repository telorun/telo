# @telorun/fs

`fs` — local filesystem access for a running Telo app. Read, write, edit,
list, create, and remove files and directories on the host the kernel runs on,
via Node `fs/promises`. Buffered (small files), UTF-8 text by default, with a
base64 escape hatch for binary and a raw-bytes path for writing what another
resource produced.

## Kinds

All are `Telo.Invocable` — invoke them from a `Run.Sequence` or wrap them as
`Ai.Tools` for an agent.

- **`Fs.File`** — read a file. `{ path, encoding? }` → `{ content, size }`.
- **`Fs.FileWrite`** — write a file whole. `{ path, content, encoding?,
  createParents? }` → `{ bytesWritten }`.
- **`Fs.FileEdit`** — edit a file in place by exact string replacement.
  `{ path, oldString, newString, replaceAll? }` → `{ replacements }`. Fails when
  `oldString` is absent, or matches more than once without `replaceAll` — never
  a silent no-op. Byte-level, so comments and `!cel` tags survive.
- **`Fs.DirectoryListing`** — list a directory. `{ path?, recursive? }` →
  `{ entries: [{ name, path, type, size }] }`; each `path` is relative to `cwd`
  so it can be fed straight back as an input.

  **Every emitted `path` is separated with `/`, on every host.** A path that
  reaches a manifest stops being a host path: an author compares it in CEL
  (`f.path == 'a/b.txt'`) and that manifest runs everywhere, so a Windows
  `a\b.txt` would make the same expression match on one platform and miss on
  another. This matches how the rest of Telo names paths a manifest can see —
  module refs, `include:` globs, `!include-text`. Inputs are the loose side and
  accept either separator.
- **`Fs.DirectoryCreation`** — create a directory. `{ path, createParents? }` →
  `{ created }`. With `createParents` it's idempotent (`created: false` when it
  already existed); without, an existing path or missing parent is an error.
- **`Fs.FileRemoval`** — remove a file, or a tree with `recursive`.
  `{ path, recursive? }` → `{ removed }`.
- **`Fs.TreeSnapshot`** — content-hash a directory tree.
  `{ path?, exclude? }` → `{ files: [{ path, hash }] }`, `hash` the sha256 hex
  of the file's bytes. A content hash is a reliable change detector where
  `DirectoryListing`'s `size` is not (equal size ≠ equal content), so two
  snapshots diff to an exact change set. `exclude` skips entries by base name at
  any depth (e.g. `node_modules`, `.git`, `dist`).
- **`Fs.TreeSync`** — apply an **explicit** change set.
  `{ write?: [{ path, content, encoding? }], delete?: [path] }` →
  `{ written, deleted }`. Writes each file (creating parents), then removes each
  deleted path — but never implicitly deletes a file absent from the set, so one
  call serves both a full seed (all files, empty `delete`) and a partial delta
  (only what changed) without disturbing untouched files.

`TreeSnapshot` + `TreeSync` compose into two-way tree sync: snapshot both sides,
diff the hashes, and push exactly the differing files as a `TreeSync` write/delete
set.

## `cwd`

Each resource carries an optional `cwd` — the base directory invoke `path`s
resolve against. A relative `cwd` (and the default) resolves against the process
working directory; an absolute invoke `path` is used as-is. It is **not** a
security boundary: nothing confines paths to `cwd`. Real isolation comes from
where the kernel runs (the runner sandbox), not this field. `cwd` is a
compile-time field, so it can be a `!cel` value (e.g. `!cel "variables.workspace"`).

## Text vs. binary

Content is UTF-8 text by default. Pass `encoding: base64` to read or write
binary: `Fs.File` returns the bytes base64-encoded, and `Fs.FileWrite` decodes a
base64 `content` to bytes before writing.

`Fs.FileWrite` and `Fs.TreeSync` also accept **raw bytes** as `content` — what a
byte-producing resource hands over (`Ai.Image`, `Image.Blank`, `Image.Overlay`, a
decoder). They are written as they are, so `encoding` does not apply to them, and no
base64 round trip sits between producing bytes and saving them. The slot is declared
`x-telo-binary`, so bytes must arrive by reference: an inline literal there is a
static error, and `encoding: base64` remains the way to author binary by hand.

```yaml
  - name: Save
    inputs:
      path: ./poster.png
      content: !cel "steps.Generate.result.images[0].data"
    invoke: !ref SaveImage
```

## Errors

Errors are surfaced, never swallowed. A missing file (`ENOENT`), a permission
failure (`EACCES`), and the like raise an actionable error naming the offending
path and code; an `Fs.FileEdit` with an absent or ambiguous `oldString` fails
rather than silently doing nothing.

## What is logged

Writes log at `debug` with the path and byte count. **Removals log at `info`**,
because a deletion is the one operation that leaves nothing behind to inspect
afterwards: `Fs.FileRemoval` logs the path it removed, and `Fs.TreeSync` logs a
single record with the number of paths it deleted (each path individually at
`debug`, since a routine delta legitimately carries hundreds and one `info` each
would make it the loudest thing in the log).

That account matters most for `Fs.TreeSync`, whose delete is recursive and
`force: true` — a mistyped path takes a whole tree, and a path that never existed
reports success either way.

File **contents are never logged** — only where they went and how many bytes.

## Example

```yaml
imports:
  Fs: oci://ghcr.io/telorun/fs@0.1.0

kind: Fs.File
metadata: { name: ReadFile }
cwd: ./workspace
---
kind: Fs.FileEdit
metadata: { name: EditFile }
cwd: ./workspace
# invoked from a Run.Sequence (or wrapped as an Ai.Tools tool):
#   - name: Read
#     invoke: !ref ReadFile
#     inputs: { path: telo.yaml }                                    # → { content, size }
#   - name: Edit
#     invoke: !ref EditFile
#     inputs: { path: telo.yaml, oldString: "version: 1", newString: "version: 2" }  # → { replacements }
```
