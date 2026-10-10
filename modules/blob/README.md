# Blob

`blob` — binary objects under keys, independent of where they are kept. An
application saves an upload, reads an attachment back, asks how large it is and
removes it through four operations; which storage holds the bytes is a separate
resource the operations name by reference, so it can be changed without touching
them.

## Why use this

- **One contract, any storage.** The operations, their inputs and outputs and
  their error codes are the same whatever the store is.
- **Streams in and out.** Content is stored as it arrives and read as it is
  consumed, so an object is never held whole in memory unless the caller asks.
- **Bounded.** `maxBytes` on a put refuses larger content with nothing stored; on
  a get it refuses a larger object before any of it is read.
- **Atomic replace.** A put replaces an object in one step. A reader sees the old
  content or the new, and a put that fails leaves the old one in place.
- **Checked keys.** A key is a `Blob.Key`; one outside its grammar — `../x`, an
  empty segment — is refused by `telo check` when it is a literal and by the
  input contract when it is computed.

## Kinds

| Name | What it is |
| --- | --- |
| [`Blob.Put`](docs/operations.md#blobput) | Store bytes or a byte stream under a key. `{ key, content, contentType, maxBytes? }` → `{ key, size, sha256, contentType }`. |
| [`Blob.Get`](docs/operations.md#blobget) | Read a blob as a byte stream. `{ key, maxBytes? }` → `{ output, size, contentType }`. |
| [`Blob.Head`](docs/operations.md#blobhead) | A blob's size and media type, content unread. `{ key }` → `{ size, contentType }`. |
| [`Blob.Delete`](docs/operations.md#blobdelete) | Remove a blob. `{ key }` → `{ key }`. A missing key succeeds. |
| `Blob.Store` | Abstract: where blobs are kept. A storage module provides a kind that extends it. Contract: [docs/store-contract.md](docs/store-contract.md). |
| [`Blob.Key`](docs/operations.md#keys) | The shape of a key. |

Each operation has one configuration field, `store` — a required reference to a
`Blob.Store`.

## Example

An upload route that stores the request body under a key it generates.
`attachments` is a store declared with a storage module's kind.

```yaml
kind: Http.Api
metadata: { name: files }
routes:
  - request:
      path: /files
      method: POST
      schema:
        body:
          x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
    handler:
      kind: Blob.Put
      store: !ref attachments
    inputs:
      key: !interpolate "uploads/${{ uuidv4() }}"
      content: !cel "request.body"
      contentType: application/pdf
      maxBytes: 10485760
    returns:
      - status: 201
        content:
          application/json:
            body:
              key: !cel "result.key"
              size: !cel "result.size"
              sha256: !cel "result.sha256"
    catches:
      - when: !cel "error.code == 'ERR_BLOB_TOO_LARGE'"
        status: 413
        content:
          application/json:
            body: { error: !cel "error.message" }
```

Never build a key from text a client chose, such as a file name: generate the key
and keep the client's name beside it in your own records.

## Reference

- [Operations](docs/operations.md) — inputs, outputs, codes, keys and media types.
- [Store contract](docs/store-contract.md) — what a storage module implements.
