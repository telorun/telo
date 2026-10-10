# `Fs.FileWrite`

> Examples assume this module is imported under the alias `Fs`.

Writes one file, replacing it whole.

```yaml
kind: Fs.FileWrite
metadata: { name: saveFile }
cwd: !cel "variables.workspace"
```

## Inputs

| Field           | Type                              | Required | Purpose                                                                  |
| --------------- | --------------------------------- | -------- | ------------------------------------------------------------------------ |
| `path`          | string                            | yes      | File to write, relative to `cwd` (an absolute path is used as-is).       |
| `content`       | text, bytes, or a stream of bytes | yes      | What to write. See the three forms below.                                |
| `encoding`      | `utf8` \| `base64`                | no       | How a text `content` is read. `base64` decodes it first. Default `utf8`. |
| `createParents` | boolean                           | no       | Create missing parent directories first. Default `false`.                |
| `maxBytes`      | integer ≥ 0                       | no       | The most bytes this call writes. Omitted: no limit.                      |

## Output

| Field          | Type    | Meaning                          |
| -------------- | ------- | -------------------------------- |
| `bytesWritten` | integer | Number of bytes written to disk. |

## The three forms of `content`

| Form              | Where it comes from                                                           | How it is written                              |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Text              | A literal or a CEL string; base64 text with `encoding: base64`                 | In place                                       |
| Bytes             | A byte-producing resource (a generated image, a decoder) or `!include-bytes`   | In place                                       |
| A stream of bytes | A streamed request body, a download, any resource whose output is a byte stream | Staged in a sibling file, then renamed over the target |

`encoding` applies to text only; bytes and a stream are written as they are. A value that is none of the three is refused: a literal by `telo check` (`CONTRACT_INPUTS_MISMATCH`), a computed one when the call is made (`ERR_INPUT_INVALID`).

## Writing a stream

A stream is written as it arrives, one chunk at a time, so an upload of any size is saved without being held in memory:

```yaml
kind: Http.Api
metadata: { name: uploads }
routes:
  - request:
      path: /files
      method: POST
      schema:
        body:
          x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
    handler: !ref saveFile
    inputs:
      path: !interpolate "uploads/${{ uuidv4() }}.bin"
      createParents: true
      content: !cel "request.body"
      maxBytes: 10485760
    returns:
      - status: 200
        content:
          application/json:
            body: { bytesWritten: !cel "result.bytesWritten" }
    catches:
      - when: !cel "error.code == 'ERR_FILE_TOO_LARGE'"
        status: 413
        content:
          application/json:
            body: { error: !cel "error.message" }
```

The bytes go to a temporary file named `.<basename>.<random>.tmp` in the target's own directory. When the stream ends, that file is renamed over the target. A reader therefore sees the previous file or the new one, never part of an upload, and a stream that fails or is refused leaves the target exactly as it was — its previous content, or still absent.

What that costs, compared with text and bytes, which are written into the existing file:

- **The target becomes a new file.** The rename replaces the directory entry, so the file has a new inode: another hard link to the old file keeps the old content, and a process holding the old file open keeps reading the old content. The new file keeps the old one's permission bits; its owner is whoever runs the application.
- **The directory must be writable**, not only the file, since the temporary file is created beside the target. A target that is a single file mounted into a container (a bind-mounted file) cannot be renamed over; mount its directory instead, or write text or bytes.
- **A symbolic link is written through.** The file the link names is the one replaced, the temporary file is created beside that file, and the link stays a link.
- **A target that is not a regular file is written in place.** A FIFO, a device or a socket has no content to replace, so the stream is written straight into it, and bytes written before a failure or a refusal stay written.
- **The file name grows by 22 characters while it is written.** The temporary file is `.`, the target's basename, `.`, 16 hex characters and `.tmp`, so a stream written to a name within 22 characters of the filesystem's limit (255 bytes on most) fails with `ENAMETOOLONG` where the same name written as text or bytes succeeds.
- **A killed process can leave a `.tmp` sibling.** The temporary file is removed on every failure the process lives through. One that is killed mid-write leaves it behind, and nothing removes it later. It is never read as the target.

Nothing is flushed to stable storage before the rename, so the guarantee is about what other processes see, not about a power loss.

## Bounding a write

`maxBytes` applies to every form, and what was there before is always kept.

- **Text and bytes** have a known size, so the bound is decided before the file is opened. `error.data` carries `path`, `maxBytes` and `size`.
- **A stream** is counted as it is pulled. The chunk that crosses the bound is not written, the source is released, the temporary file is removed, and `error.data` carries `path` and `maxBytes` — no `size`, since the stream's size was never learned. At most `maxBytes` plus one chunk is read from the source.

Content of exactly `maxBytes` is written. `maxBytes: 0` admits only empty content.

A streamed request body has a limit of its own, the server's `maxBodyBytes`. Crossing it cancels the request: the stream fails, the temporary file is removed and the target is untouched, and the server has already answered 413 — the route's `catches:` never sees it.

## Errors

| Code                 | When                                  | `error.data`                                              |
| -------------------- | ------------------------------------- | --------------------------------------------------------- |
| `ERR_FILE_TOO_LARGE` | The content is larger than `maxBytes`. | `path`, `maxBytes`, and `size` for text and bytes only. |

A failure of the stream's source is raised as it arrived — same code, same data — after the temporary file is removed. **A stream is released on every failure**, including one before the first byte is read — a parent directory that cannot be created, a directory that cannot be written, a loop of symbolic links — so whatever produced it is told to stop rather than left open. A filesystem failure (a missing parent, a permission failure, a rename that the host refuses) raises an error naming the path and the system code (`ENOENT`, `EACCES`, `EXDEV`), again with the target untouched.
