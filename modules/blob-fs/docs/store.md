# `BlobFs.Store`

> Examples assume this module is imported under the alias `BlobFs`, and `blob` under `Blob`.

A `Blob.Store` that keeps each blob as one file under a root directory.

```yaml
kind: BlobFs.Store
metadata: { name: attachments }
root: !cel "variables.blobRoot"
```

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `root` | `Telo.HostPath` | yes | The directory blobs are kept under. Evaluated once, when the store is created. |

`root` is an absolute path on the host. It comes from a variable declared `x-telo-type: Telo.HostPath`, whose value — relative or not — resolves against the working directory; a relative literal is refused (`HOST_PATH_RELATIVE`). The directory is created by the first put; a store whose root does not exist yet reads as empty.

Every process given the same `root` shares one store. Give the directory to this store alone: files it did not write there are not blobs, and it refuses to read one as a blob.

## Layout

```
<root>/
  <h[0..2]>/<h[2..4]>/<h[4..64]>    one file per blob
  .tmp/<random>                     a blob being written
```

`h` is the SHA-256 of the key's UTF-8 bytes, written as 64 lower-case hex characters: the first two characters name a directory, the next two a directory inside it, and the remaining sixty the file. The key `docs/a.txt` hashes to `6b7b…`, so it is stored at `<root>/6b/7b/<the other sixty characters>`.

A key therefore never becomes a path. `a` and `a/b` are two files in unrelated directories, `Report` and `report` are two files even on a filesystem that ignores case, and a 512-character key needs a file name no longer than any other.

`<random>` is 32 lower-case hex characters, new for every put.

## File format

A blob file is a header line followed by the content:

```
{"v":1,"key":"docs/a.txt","contentType":"text/plain"}
<content bytes>
```

- The header is one line of UTF-8 JSON, ending in a single newline byte (`0x0A`). It is at most 4,096 bytes, newline included.
- Its members are, in this order: `v`, the format version, the number `1`; `key`, the blob's key; `contentType`, its media type. It has no others.
- The content starts at the byte after the newline and runs to the end of the file, unmodified.
- **A blob's size is the file's length minus the header's length.** It is not written in the header.

The key is in the header so that a file can be told from the blob of another key: reading a file whose `key` is not the one asked for fails with an error naming both, rather than returning another blob's content. A file with no newline in its first 4,096 bytes, a header that is not JSON, or a `v` other than `1` fails the same way.

## How a put is committed

1. The header and then the content are written to a new file in `<root>/.tmp/`, chunk by chunk as the source delivers it.
2. The file is flushed to stable storage.
3. It is renamed to the blob's path. **That rename is the commit**, and the only one — there is no second file to bring into step.

So a reader opens the previous file or the new one, never a part of either, and a reader that already has the previous file open finishes reading it. Two puts to one key each write their own staging file; whichever renames last is the blob, whole.

The source is `Blob.Put`'s to release, never the store's: a put that fails for a reason of the store's own — a root that cannot be written, a full disk — removes its staging file and throws.

When the source fails, the staging file is removed and the blob's path is never touched: the previous blob is byte for byte what it was, and the failure is raised as it arrived. That is also how a put over its size limit ends — the limit is `Blob.Put`'s, which fails the source on the chunk that crosses it; the store itself measures nothing.

**Stale staging files.** A process killed between steps 1 and 3 leaves its staging file in `.tmp/`. After its first successful put, and then at most once an hour, a store removes each entry of `.tmp/` not modified for 24 hours. A staging file being written is modified with every chunk, so only a put that has written nothing for a day is taken for dead — and such a put, if it resumes, fails at its commit with an error saying its staging file was removed; nothing is stored.

`Blob.Delete` unlinks the blob's file. The two directories above it are left in place.

## How a blob is read

`Blob.Head` and `Blob.Get` open the file, read its header and length, and close it again; neither leaves a file open. **The file is opened when the content is first read.** That first read checks that the file then at the blob's path holds a blob of the size and media type the call reported, and fails — naming the key — when it was replaced by one that differs or was deleted. From then on the file stays open until the content has been read to its end or released, so a blob replaced or deleted meanwhile is still read whole.

## Limits

- **`root` must be one filesystem.** The commit is a rename from `.tmp/` into a sibling directory, which is atomic only within one filesystem.
- **Rename-over-an-open-file semantics are POSIX's.** On a filesystem that refuses to replace a file another process has open, a put to a key being read fails rather than committing.
- **No listing.** The layout holds hashes, and the key is inside each file. A listing of keys would be a scan of every file's header, in hash order rather than key order.
- **Nothing is removed on its own** except stale staging files: a blob stays until it is deleted.
- **A failed sweep or a staging file that cannot be removed is logged** at `warn` and does not fail the put it followed, since the blob is already stored.
