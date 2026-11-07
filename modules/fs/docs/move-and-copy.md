# `Fs.Move` and `Fs.Copy`

> Examples assume this module is imported under the alias `Fs`.

```yaml
kind: Fs.Move
metadata: { name: moveFile }
cwd: !cel "variables.workspace"
---
kind: Fs.Copy
metadata: { name: copyFile }
cwd: !cel "variables.workspace"
```

Both take `{ path, destination }`, each relative to `cwd` (an absolute path is used as-is), for a file or a directory, and create the destination's missing parent directories. Both refuse before changing anything when the destination exists, lies inside the source (or is it), or the source is absent. A refusal leaves the tree as it was, including any parent it would have created.

## `Fs.Move`

Renames in one `rename(2)`; a regular file is instead hard-linked at the destination and then unlinked from the source, so a destination created after the check is refused with `ERR_PATH_EXISTS`, never replaced. Returns `{ moved, destination }`, the two paths as given.

Residual race: Node has no no-replace rename, so a directory (the move's, and a copy's final placement of a directory) created at the destination as an empty directory, or a file created there, between the check and the rename is replaced; a non-empty directory is refused with `ERR_PATH_EXISTS`. A filesystem that cannot hard-link falls back to `rename(2)` with the same race.

A rename cannot cross filesystems: that is `ERR_MOVE_CROSS_DEVICE`, and copying across devices is not this kind's job. Compose `Fs.Copy` with `Fs.FileRemoval` for that.

## `Fs.Copy`

Copies a file, or a directory with everything beneath it; across filesystems is fine. Returns `{ copied, destination, files }`, `files` the number of regular files copied.

**All or nothing.** The copy is built in a hidden sibling of `destination` and renamed into place, so no reader sees part of it. A failure part-way removes that sibling and the parents the call made, then raises the failure (an `Error` naming the path and the system code). If that cleanup fails too, the original failure is still the one raised, with the cleanup failure on its `cleanupFailure` property and in its message. `Fs.Move` does the same for the parents it made. Source files are never changed.

A symbolic link or a special file (socket, device, FIFO) anywhere in the source refuses the whole copy with `ERR_COPY_UNSUPPORTED_ENTRY`, before anything is written: the kind does not decide what copying a link means.

## Codes

| Code | Raised by | Meaning | `data` |
| --- | --- | --- | --- |
| `ERR_PATH_EXISTS` | both | The destination exists. | `path` (resolved destination) |
| `ERR_PATH_NOT_FOUND` | both | The source is absent. | `path` (resolved source) |
| `ERR_MOVE_INTO_ITSELF` | `Fs.Move` | Destination is the source or inside it. | `path`, `destination` |
| `ERR_COPY_INTO_ITSELF` | `Fs.Copy` | Destination is the source or inside it. | `path`, `destination` |
| `ERR_MOVE_CROSS_DEVICE` | `Fs.Move` | The rename would cross filesystems. | `path`, `destination` |
| `ERR_COPY_UNSUPPORTED_ENTRY` | `Fs.Copy` | A link or special file in the source. | `path` (the entry) |

"Inside" is judged on physical locations, so a destination reached through a symbolic link into the source is refused too.

## What is logged

A move logs at `info` (the source disappears from where it was); a copy at `debug`, with the paths and file count.
