# `Fs.TreeSnapshot`

> Examples assume this module is imported under the alias `Fs`.

Content-hashes files and directory trees. Hashing content rather than comparing sizes or timestamps means two snapshots diff into an exact change set.

```yaml
kind: Fs.TreeSnapshot
metadata: { name: snapshot }
cwd: !cel "variables.workspace"
```

## Inputs

| Field     | Type     | Required | Purpose                                                                                     |
| --------- | -------- | -------- | ------------------------------------------------------------------------------------------- |
| `paths`   | string[] | no       | The files and directories to snapshot, each relative to `cwd`. Omitted: `cwd` itself.       |
| `exclude` | string[] | no       | Base names to skip at any depth (an excluded directory is not descended).                   |

Each entry of `paths` is a **root**: a file contributes itself, a directory every regular file beneath it. Roots may be mixed freely, and a file two roots both reach is reported once. An empty list snapshots nothing. `exclude` applies beneath a root, never to the root itself — naming a path asks for it.

Symbolic links are not followed: one met during a walk is skipped, and a root that is one contributes nothing. More generally, a requested path that exists but is neither a regular file nor a directory — a symbolic link, a device, a socket — appears in **neither** `files` nor `missing`: `missing` means nothing exists there, and only regular files are hashed.

## Output

| Field     | Type     | Meaning                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------- |
| `files`   | array    | `{ path, hash, size }` per regular file, sorted by `path` (see below).                |
| `missing` | string[] | The requested `paths` at which nothing exists, as written. Empty when all exist.      |

`files` is ordered by the whole `path` compared by Unicode code point — the order of its UTF-8 bytes, not UTF-16 code-unit order — the same order [`Fs.DirectoryListing`](./directory-listing.md) returns its entries in.

`hash` is the sha256 hex digest of the file's bytes — the value [`Fs.File`](./file.md) reports as `sha256` — and `size` its length in bytes. `path` is relative to `cwd` and separated with `/` on every host.

A root that does not exist is **not an error**: it is reported in `missing`, which is how a caller learns that a file it is about to create is new, in the same call that hashes the files that are there.

```yaml
- name: before
  invoke: !ref snapshot
  inputs:
    paths: [src/app.yaml, src/routes, notes/todo.md]
# → files:   [{ path: src/app.yaml, hash: …, size: 412 }, { path: src/routes/users.yaml, … }]
#   missing: [notes/todo.md]
```

## Syncing two trees

Snapshot both sides, compare `hash` by `path`, and hand the differing files to `Fs.TreeSync` as an explicit write / delete set.
