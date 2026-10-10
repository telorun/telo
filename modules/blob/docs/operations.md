# Blob operations

> Examples assume this module is imported under the alias `Blob`.

Four invocable kinds. Each is configured with one field:

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `store` | reference to a `Blob.Store` | yes | The store the blob is kept in. Anything else there is `REFERENCE_KIND_MISMATCH`. |

```yaml
kind: Blob.Put
metadata: { name: saveAttachment }
store: !ref attachments
```

## Keys

A key is a `Blob.Key`:

- one or more segments separated by `/`;
- each segment starts with a letter or a digit and continues with letters, digits, `.`, `_` or `-`;
- 1 to 512 characters in all, with no limit on one segment;
- case-sensitive — `Report.pdf` and `report.pdf` are two blobs.

So a segment is never empty, `.` or `..`, and a key never starts or ends with `/`. `a` and `a/b` are two unrelated blobs: a key is a name, not a path into a directory, and no operation lists keys.

A literal key outside the grammar is refused by `telo check` (`CONTRACT_INPUTS_MISMATCH`); a computed one when the call is made (`ERR_INPUT_INVALID`). Every store holds every valid key.

## Media types

`contentType` is a media type written as lower-case `type/subtype` with no parameters: `image/png`, `application/pdf`, `text/plain` — never `Text/Plain`, never `text/plain; charset=utf-8`. Each side starts with a letter or digit, continues with letters, digits and `!#$&^_.+-`, and is at most 127 characters long. `Blob.Put` refuses anything else — a literal at `telo check`, a computed value with `ERR_INPUT_INVALID`. Nothing inspects the content: the media type is what the caller said it was.

`Blob.Get` and `Blob.Head` always answer in the same form. A store returns what its medium recorded, which for a blob put there by something else may carry parameters or upper case, so on the way out the text before the first `;` is taken, trimmed and lower-cased — `Text/HTML; charset=utf-8` reads as `text/html` — and whatever is still not a `type/subtype` reads as `application/octet-stream`.

## `Blob.Put`

Stores content under a key, replacing whatever was there.

| Input | Type | Required | Purpose |
| --- | --- | --- | --- |
| `key` | `Blob.Key` | yes | The key to store under. |
| `content` | bytes, or a stream of bytes | yes | What to store. A stream is stored as it arrives. |
| `contentType` | media type | yes | The content's media type. |
| `maxBytes` | integer ≥ 0 | no | The most content bytes to store. Omitted: no limit. |

| Output | Type | Meaning |
| --- | --- | --- |
| `key` | `Blob.Key` | The key the content was stored under. |
| `size` | integer | Content bytes stored. |
| `sha256` | string | Lower-case hex SHA-256 digest of the stored content. |
| `contentType` | media type | The media type it was stored with. |

- **Replace is atomic.** A reader sees the previous blob or the new one, never a mixture; a reader already part-way through the previous blob finishes it.
- **A failed put stores nothing.** If the content's source fails, the failure is raised as it arrived and the previous blob — if there was one — is still the one read. If the put fails for any other reason — the store's own failure, before it read anything or after — nothing is stored either, and the source is released.
- **`maxBytes` stores nothing either.** Bytes held whole are refused before the store is called. A stream is refused on the chunk that crosses the bound; at most `maxBytes` plus one chunk is read from it.
- **`size` and `sha256` are computed as the content passes**, by the operation, so they mean the same whatever the store is.
- **A stream must yield bytes.** A chunk that is anything else fails the call with `ERR_INPUT_INVALID`, and nothing is stored.

| Code | When | `error.data` |
| --- | --- | --- |
| `ERR_BLOB_TOO_LARGE` | The content is larger than `maxBytes`. | `key`, `maxBytes` |

## `Blob.Get`

Reads a blob.

| Input | Type | Required | Purpose |
| --- | --- | --- | --- |
| `key` | `Blob.Key` | yes | The key to read. |
| `maxBytes` | integer ≥ 0 | no | The largest blob to read. Omitted: no limit. |

| Output | Type | Meaning |
| --- | --- | --- |
| `output` | stream of bytes | The content, read as it is consumed. |
| `size` | integer | The blob's size in bytes. |
| `contentType` | media type | The media type it was stored with. |

`output` holds nothing until it is first read, so a call that answers from `size` or `contentType` alone leaves nothing open. If the blob is replaced by one of another size or type, or deleted, between the call and the first read, that read fails; a read that has begun finishes with the blob it began with.

`output` is consumed once, by handing it to something that reads a byte stream — a response body, a decoder, another put. `maxBytes` is judged against the size the store reports, before any content is read, so a caller that will hold the blob in memory passes its budget and never starts a read it cannot finish.

| Code | When | `error.data` |
| --- | --- | --- |
| `ERR_BLOB_NOT_FOUND` | Nothing is stored under the key. | `key` |
| `ERR_BLOB_TOO_LARGE` | The blob is larger than `maxBytes`. | `key`, `size`, `maxBytes` |

## `Blob.Head`

A blob's size and media type, without reading its content.

| Input | Type | Required | Purpose |
| --- | --- | --- | --- |
| `key` | `Blob.Key` | yes | The key to inspect. |

| Output | Type | Meaning |
| --- | --- | --- |
| `size` | integer | The blob's size in bytes. |
| `contentType` | media type | The media type it was stored with. |

| Code | When | `error.data` |
| --- | --- | --- |
| `ERR_BLOB_NOT_FOUND` | Nothing is stored under the key. | `key` |

## `Blob.Delete`

Removes a blob.

| Input | Type | Required | Purpose |
| --- | --- | --- | --- |
| `key` | `Blob.Key` | yes | The key to remove. |

| Output | Type | Meaning |
| --- | --- | --- |
| `key` | `Blob.Key` | The key that was removed, or that held nothing. |

Deleting a key that holds nothing succeeds, and the output does not say which happened. It declares no code.

## What is not here

There is no listing, copy, range read or time-limited link. A caller that needs to find its blobs again keeps their keys in its own records.
