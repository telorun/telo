# @telorun/fs

`std/fs` — local filesystem access for a running Telo app. Read, write, edit,
list, create, and remove files and directories on the host the kernel runs on,
via Node `fs/promises`. Buffered (small files), UTF-8 text by default with a
base64 escape hatch for binary.

## Kinds

All six are `Telo.Invocable` — invoke them from a `Run.Sequence` or wrap them as
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
- **`Fs.DirectoryCreation`** — create a directory. `{ path, createParents? }` →
  `{ created }`. With `createParents` it's idempotent (`created: false` when it
  already existed); without, an existing path or missing parent is an error.
- **`Fs.FileRemoval`** — remove a file, or a tree with `recursive`.
  `{ path, recursive? }` → `{ removed }`.

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

## Errors

Errors are surfaced, never swallowed. A missing file (`ENOENT`), a permission
failure (`EACCES`), and the like raise an actionable error naming the offending
path and code; an `Fs.FileEdit` with an absent or ambiguous `oldString` fails
rather than silently doing nothing.

## Example

```yaml
imports:
  Fs: std/fs@0.1.0

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
