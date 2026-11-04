# Store contract

A backend provides a kind extending `AiConversation.Store` whose instance has these methods. A store is recognised by its methods, never by having imported this module's code; `@telorun/ai-conversation` offers the TypeScript types, the coded-error constructors (`conflict`, `conversationNotFound`, `entryNotFound`, `toolCallNotFound`, `cursorInvalid`, `attachmentNotFound`) and the id minting as a convenience. Each method takes the invocation context last.

| Method | Contract |
| --- | --- |
| `create({ id, title? })` | Insert a header: version 1, not archived, no turn. An `id` that already exists answers its header unchanged. |
| `read(id)` | The header, else `ERR_CONVERSATION_NOT_FOUND`. |
| `list({ query?, archived?, direction, limit, cursor? })` | Headers ordered by `updatedAt` then id, newest first for `desc` and oldest first for `asc`; an absent `archived` lists both kinds; `total` is the number of matches; an unreadable cursor is `ERR_CONVERSATION_CURSOR_INVALID`. |
| `update({ conversation, version, title?, archived? })` | One write conditional on the version; bumps it and `updatedAt`. Stale: `ERR_CONVERSATION_CONFLICT`; unknown: `NOT_FOUND`. |
| `admit({ conversation, version, turn, attachments, expiredBefore })` | One atomic write: the header write `update` makes, conditional on the version, setting `turn`; then each named attachment bound to the conversation (rule below). A row that does not qualify rolls the whole write back with `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`, `data: { attachment }`. |
| `delete(id)` | Remove header, entries and approvals, and release the conversation's attachments, atomically. |
| `entries({ conversation, through?, limit, cursor? })` | A branch page as described in [operations](./operations.md). Each page must cost a bounded number of index reads whatever the conversation's size; one index on (conversation, parent, sequence) answers siblings and the latest-appended child. |
| `append({ conversation, id, parent, turn, message, attachments })` | Atomically: fence on the header's current turn, assign the next sequence, compute depth from the parent, refuse a parent with an undecided approval, bind each attachment (rule below, without the cutoff), insert. Not conditional on the version. |
| `recordApproval({ conversation, turn, id, entry, toolCallId, decision? })` | Fenced as `append`; request and decision as described in [operations](./operations.md). |
| `registerAttachment({ id, name?, binding? })` | Insert a pending row (no conversation, not released) and answer its record. With `binding: { conversation, turn }`, atomically: fence on the header's current turn as `append` does, then insert the row bound to that conversation. An `id` that already exists answers its record unchanged only while it is unreleased and as this call would have left it — pending without `binding`, bound to `binding.conversation` with it; otherwise `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`, `data: { attachment }`. |
| `readAttachment(id)` | The record `{ id, conversation, name, createdAt, boundAt }`, `conversation` and `boundAt` null while pending. Unknown or released: `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`. |
| `expireAttachments({ expiredBefore, limit })` | Release up to `limit` pending rows registered before `expiredBefore`, then answer `{ ids }`: up to `limit` released rows. |
| `forgetAttachments({ ids })` | Delete the named rows, released ones only. |

## Attachments

A row is **pending** (no conversation, not released), **bound** (a conversation, not released) or **released** (`released_at` set, by expiry or by the conversation's deletion). A row registered with a `binding` is bound from the start and never pending. A bind names a row that is unreleased and either pending — and for `admit`, registered at or after `expiredBefore` — or already bound to this conversation; its `boundAt` is kept once set. A bind and a release are each one conditional write the database enforces on the row, so of the two racing for one row exactly one takes effect, whatever the replicas' clocks. `expiredBefore` means the same on `admit` and on `expireAttachments`. A store keeps no file bytes: whoever reads `expireAttachments` removes each file's bytes before calling `forgetAttachments`.

A store stores and answers; the operations own input contracts, id minting (`att_…` included) and the retryable wrapping of storage failures.
