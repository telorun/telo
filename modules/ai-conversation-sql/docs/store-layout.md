# Store layout

Five tables, named `<tablePrefix>` + `schema`, `conversations`, `entries`, `approvals`, `attachments` (default prefix `ai_conversation_`; the prefix must be a plain identifier).

| Table | Holds |
| --- | --- |
| `schema` | One row: the recorded schema version. |
| `conversations` | The header: id, title, archived, turn, version, `next_sequence` (the last sequence handed out), created and updated as epoch milliseconds. Indexed on (`archived`, `updated_at`, id) for a listing filtered by `archived`, and on (`updated_at`, id) for the unfiltered one. |
| `entries` | One row per entry: id, conversation, parent (`''` for a root, so the branch index can use plain equality), `seq`, `depth`, turn, the message as JSON, created. Unique on (conversation, `seq`); indexed on (conversation, parent, `seq`). |
| `approvals` | One row per gated tool call: id, entry, tool call id, requested-at, and once decided the decision, decided-at and deciding turn. Unique per (conversation, entry, tool call). |
| `attachments` | One row per file: id (the public `att_…` id), `conversation_id` (null while pending), `name`, `created_at`, `bound_at` and `released_at` (both null until set). Indexed on (`conversation_id`, `released_at`, `created_at`) for the release on delete and the scan for expired pending files, and on (`released_at`) for the scan for released ones. |

Timestamps are written by the process (`Date.now()`), so keep hosts on NTP; ordering within a conversation uses `seq`, never a timestamp.

## Schema versions

The version is recorded in `<prefix>schema`. This module writes **version 3**. **Version 0** is any state before a version was recorded: no tables at all, or tables with no version row. Starting over version 0 runs the version-1 step — idempotent `CREATE … IF NOT EXISTS` for every table and index — then version 2, which adds the (`updated_at`, id) index the unfiltered listing orders by, then version 3, which adds the `attachments` table and its indexes; a database at version 1 runs versions 2 and 3, one at version 2 runs version 3 alone. Each then records the new version, so existing rows are kept, and all steps run in one transaction. Version 3 adds no rows for files stored before it: they read as not found and nothing removes them. A recorded version above 3 is refused (`ERR_CONVERSATION_SCHEMA_NEWER`) with the tables untouched.

With `createTables: false` nothing is created or upgraded: the recorded version must be exactly the current one (`ERR_CONVERSATION_SCHEMA_OUTDATED` for an older one, `ERR_CONVERSATION_SCHEMA_NEWER` for a newer one), and a missing schema table is the database's own error. Replicas starting at the same moment against an empty PostgreSQL database may collide on `CREATE`; the loser runs the idempotent pass again over what the winner created, and a second failure is reported as it is.

## Concurrency

`Append` and `RecordApproval` run in a transaction whose first statement is a guarded `UPDATE` of the header row (`WHERE turn = <named turn>`): it fences, takes the row lock that serialises writers of one conversation, and hands out the next sequence. `Update` is one statement conditional on the version; `Admit` is that statement plus the binds, in one transaction.

A bind (in `Admit` and `Append`) and a release (in `Delete` and `ExpireAttachments`) are each a conditional `UPDATE` of the attachment row carrying the whole condition — unreleased, and pending or this conversation's for a bind; pending and unbound for a release. Of a bind and a release racing for one row, the second re-checks its condition against the row the first committed, so a file is bound or released, never both. A bind that matches no row rolls its whole write back with `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`. A registration with a `binding` runs in one transaction: the header `UPDATE` fencing on the turn, as an append's, then an `INSERT` of the row already bound. A registration whose id exists inserts nothing and answers the row only when it is unreleased and pending (without a binding) or bound to the binding's conversation (with one); any other is `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`. `ForgetAttachments` deletes only released rows.

## Trade-offs

- A `Entries` call with `through` finds the leaf with a recursive statement over the entries below that entry, so it costs the length of that sub-branch (not the conversation's size); repeat `through` with a cursor so `total` stays the same branch's length. Without `through` the leaf is one index read.
- `List` orders by `updatedAt`; a conversation that moves while a client pages may be skipped or repeated, as with any keyset over a changing key.
- Title search is a case-insensitive substring scan.
