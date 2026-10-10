# Store contract

`Blob.Store` is the abstract every storage module implements. `Blob.Put`, `Blob.Get`, `Blob.Head` and `Blob.Delete` reach a store through their `store:` reference and call the four methods below on the instance; a module whose store kind implements them can stand behind all four with no other change. This page is normative.

## What a storage module declares

One kind with `extends: <Alias>.Store`, where `<Alias>` is its import of this module, and `capability: Telo.Provider`. Its schema is its own — a directory, a bucket and credentials, a connection — since the abstract declares none.

## How a store is recognised

**By its methods, and by nothing else.** The operations accept any instance that has `put`, `get`, `head` and `delete` as functions. They never test its class and never require it to have imported anything, so a store can live in another module, another repository or another bundle.

The contract's TypeScript types (`BlobStore` and what its methods resolve with) and the guard `isBlobStore` are available under the specifier `@telorun/blob`, resolved through this module's `exports.code`. Importing them is a convenience for type checking; a store that imports nothing is still a store.

## The methods

| Method | Resolves with |
| --- | --- |
| `put(key, content, { contentType }, ctx)` | nothing, once the blob is stored |
| `get(key, ctx)` | `{ status: "found", size, contentType, content }`, or `{ status: "absent" }` |
| `head(key, ctx)` | `{ status: "found", size, contentType }`, or `{ status: "absent" }` |
| `delete(key, ctx)` | nothing |

- `key` is a valid `Blob.Key`, and `put`'s `contentType` a lower-case `type/subtype` with no parameters, at most 127 characters on each side; both were checked before the call.
- `content` is an async iterable of `Uint8Array` chunks, in both directions.
- `size` is a number of content bytes.

### A store stores

**A store knows no byte bound and computes nothing.** Counting the bytes of a put, hashing them, refusing content over a limit, refusing a blob too large to read, and every error code (`ERR_BLOB_NOT_FOUND`, `ERR_BLOB_TOO_LARGE`) belong to the operation kinds, which do them once for every store. Nothing about a bound, a digest or a size-on-put crosses this seam.

A missing blob is the outcome `absent`. Any failure — a lost connection, a refused credential, a full disk — is thrown as it arrives; it is never swallowed and never reported as an outcome.

### The context

`ctx` is the context of the invocation that made the call, handed on as the operation received it; it may be absent. A store whose work is a remote call honours its cancellation, so a cancelled request stops the upload or download it started. A store whose work is local may ignore it.

### `put`

1. **The whole source, or nothing.** The blob under `key` changes only after the source has ended. Until then, and after any failure, a `get` or `head` of the key answers exactly as before the call.
2. **Replace is atomic.** There is no moment at which the key holds part of the new content, a mixture of old and new, or — when it held a blob before — nothing.
3. **A source failure passes through intact.** If pulling the source rejects, discard everything staged and rethrow that same error — not a wrapper, not a new one. This is how an operation's own refusal reaches the store: content over the caller's limit, or a chunk that is not bytes, arrives as a failure of the source, and a cancelled upload must remain a cancellation.
4. **The source is not the store's to release.** When a put ends before the source has — a failure of the store's own, before its first pull or after it — the store discards what it staged and throws that failure. The operation that made the call releases the source. A store may call `return()` on what it was handed (a `for await` that exits early does); it is safe at any time, any number of times, and changes nothing.
5. **Read the source once, as it comes.** It is single-pass and of unknown length.
6. **`contentType` is kept with the blob.**
7. Concurrent puts to one key each either take effect whole or not at all; afterwards the key holds one of them.

### `get`

1. `absent` when nothing is stored under the key.
2. Otherwise `found`, with the size and media type of the blob stored when `get` answered.
3. `content` is single-use and read only as it is pulled — never buffered whole.
4. **`get` leaves nothing open.** Whatever it opened to learn the size and type it closes before it answers; `content` opens the read at its first pull. Content that is never pulled and never released holds nothing.
5. **The first pull delivers the blob that was described, or fails.** If the blob then stored has another size or media type, or is gone, the pull fails with an error naming the key (uncoded — a store failure thrown as it arrives).
6. `return()` is safe before the first pull, where there is nothing to release, and releases what the read holds after it.
7. A read that has begun delivers that blob whole even if the key is replaced or deleted meanwhile — or fails; never a mixture.

### `head`

`found` with the size and media type, or `absent`. It reads no content.

### `delete`

Removes the blob. A key that holds nothing is not a failure, and the store does not report which was the case.

### The media type a store returns

`get` and `head` return the media type **as the medium records it, verbatim** — and `application/octet-stream` when it records none. A store does not normalise it: a blob written to the medium by something else may carry parameters or upper case, and the operations reduce it for every store (parameters dropped, lower-cased, `application/octet-stream` for anything that is still not `type/subtype`).

## How the contract changes

Additively only, so a store written against it keeps working: a new optional member of an options object, which a store may ignore. A new capability — one a store must implement for an operation to work — is a further abstract level extending `Blob.Store`, with its own methods and its own guard, never a fifth method here. The contract carries no version marker.

## Keys

**A store must hold any valid key.** The grammar — segments of `[A-Za-z0-9][A-Za-z0-9._-]*` joined by `/`, 1 to 512 characters, case-sensitive, no bound on one segment — is the whole of what a caller may rely on, so a store cannot refuse a key for its length, its depth, or because it differs from another only by case, and it must keep `a` and `a/b` as two unrelated blobs. A store whose medium cannot hold keys as they are (a case-insensitive filesystem, a path-length limit) maps each key to a name it can hold; it does not narrow the grammar. No operation lists keys, so a store never has to recover a key from its own layout — but it should record the key beside the content, to be able to tell a blob stored for another key from the one asked for.

## Meeting the contract over a remote object store

The contract asks for nothing a typical remote object-storage service — objects in a bucket, written and read over HTTP, with multipart upload — does not provide. Operation by operation:

| Contract | How such a store meets it |
| --- | --- |
| Every valid key is held | A valid key is already a legal object name on such a service — ASCII letters, digits and `.`, `_`, `-`, `/`, at most 512 bytes, compared byte for byte — so it is used as the object name unchanged, optionally under a prefix. |
| `put` reads the source once, of unknown length | A streamed multipart upload: buffer one part's worth of chunks, send it, repeat. Memory is bounded by the part size, not by the blob. A source that ends within the first part is sent as one ordinary upload. |
| `put` is all-or-nothing | An upload not yet completed is invisible to readers. When the source fails, abort the upload, store nothing and rethrow the failure; in the single-upload case nothing has been sent at all. When a request of the store's own fails — creating the upload, sending a part, completing it — abort whatever upload exists, store nothing and throw that failure; the source is left as it is, pulled or not. The store checks no bound, computes no digest and releases nothing. |
| Replace is atomic | Completing an upload, or a single upload, replaces the object as one step; readers see the old object or the new one. |
| `contentType` kept with the blob | Sent as the object's content type when the upload is created, and returned by the service with every read and every metadata request — handed back exactly as the service returns it. |
| `head` | One metadata request, answering the object's length and content type; the service's "no such object" is `absent`. |
| `get` | One metadata request answers `found` with the object's length and content type. The first pull makes the read request and compares the length and content type its response carries with what was reported; a difference, or "no such object", fails the pull and aborts the response. `return()` before the first pull has nothing to abort; after it, it aborts the response. A read already under way is served from the object it began with. |
| `delete` | One delete request, which such a service already answers the same way whether or not the object existed. |
| The context | Each request is made with the context's cancellation, so a cancelled call aborts the request, and a cancelled put aborts its upload. |

Anything else such a service offers — listings, time-limited links, copies, ranges — is outside this contract, and stays available through the storage module's own kinds.
