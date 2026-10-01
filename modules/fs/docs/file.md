# `Fs.File`

> Examples assume this module is imported under the alias `Fs`.

Reads one file, whole, into memory.

```yaml
kind: Fs.File
metadata: { name: readFile }
cwd: !cel "variables.workspace"
```

## Inputs

| Field      | Type              | Required | Purpose                                                                 |
| ---------- | ----------------- | -------- | ----------------------------------------------------------------------- |
| `path`     | string            | yes      | File to read, relative to `cwd` (an absolute path is used as-is).       |
| `encoding` | `utf8` \| `base64`| no       | How `content` is rendered. `base64` returns the raw bytes. Default `utf8`. |
| `maxBytes` | integer ≥ 0       | no       | The largest file this call reads. Omitted: no limit.                    |

## Output

| Field     | Type    | Meaning                                                              |
| --------- | ------- | -------------------------------------------------------------------- |
| `content` | string  | The file's contents — UTF-8 text, or base64 with `encoding: base64`. |
| `size`    | integer | The file's size in bytes.                                            |
| `sha256`  | string  | sha256 hex digest of the file's bytes.                               |

`sha256` is computed over the bytes on disk, whatever the `encoding`, and is the value [`Fs.TreeSnapshot`](./tree-snapshot.md) reports as the same file's `hash` — so a read can be checked against a snapshot, or stored under its own digest, without hashing it again.

## Bounding a read

`maxBytes` makes a read safe against a file of unknown size. A file larger than the bound fails with `ERR_FILE_TOO_LARGE` **before any of its content is read** — the size is asked of the open file first — so a caller with a byte budget passes what is left of it and never buffers more:

```yaml
- name: capture
  invoke: !ref readFile
  inputs:
    path: !cel "inputs.path"
    encoding: base64
    maxBytes: !cel "inputs.remainingBytes"
```

`error.data` carries `path`, `size` and `maxBytes`, so a handler can report how far over the file was. A file exactly `maxBytes` long is read.

## Errors

| Code                 | When                                                        |
| -------------------- | ----------------------------------------------------------- |
| `ERR_FILE_TOO_LARGE` | The file is larger than `maxBytes`.                         |

A missing file, a directory, or a permission failure raises an error naming the path and the system code (`ENOENT`, `EISDIR`, `EACCES`).
