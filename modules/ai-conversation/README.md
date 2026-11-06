# AI Conversation

Persists branching chat transcripts for any AI agent consumer. A conversation is a header (title, archived flag, latest turn, version) and a forest of `Ai.Message` entries, each naming its parent. Editing or regenerating a message appends a sibling and keeps the old branch. This module is the backend-neutral half: the `AiConversation.Store` abstract, thirteen operations over it and the store contract a backend implements. Keep the data with [`ai-conversation-sql`](../ai-conversation-sql/README.md).

## Why use this

- **Branches are kept** — a regenerated reply or an edited first message is a sibling; every row carries `siblings: { position, count, previous, next }`, the same whichever branch it is read through.
- **A superseded run cannot write** — `turn` is a fencing token. `Append` and `RecordApproval` are refused with `ERR_CONVERSATION_CONFLICT` unless they name the header's current turn; a rename mid-turn does not break it because appends are not conditional on the header version.
- **Approvals are recorded once** — a gated tool call's decision can be set once, nothing can be appended beneath an undecided approval, and decisions read back with the transcript.
- **A file belongs to one conversation** — an upload is registered pending and bound in the same transaction as the write that first refers to it, so no conversation can name, read or delete another's file; deleting a conversation releases its files at once, and an expiry pass removes them with every upload no message sent.
- **Constant-cost paging** — `Entries` and `List` page by opaque cursor `{ rows, total, next }`.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `AiConversation.Store` | Provider (abstract) | Where conversations live. Implemented by a backend. |
| `AiConversation.Create` | Invocable | New conversation, optionally titled. |
| `AiConversation.Read` | Invocable | One conversation's header. |
| `AiConversation.List` | Invocable | Headers, most recently active first; filter by title text and archived. |
| `AiConversation.Entries` | Invocable | One branch, leaf toward root, a page at a time. |
| `AiConversation.Append` | Invocable | Add a message under a parent (or as a root) for a turn. |
| `AiConversation.Update` | Invocable | Title, archived; conditional on the version. |
| `AiConversation.Admit` | Invocable | Admit a turn and bind the files its message names; conditional on the version. |
| `AiConversation.Delete` | Invocable | Remove a conversation with everything in it, releasing its files. |
| `AiConversation.RecordApproval` | Invocable | Record a tool-call approval request or its decision. |
| `AiConversation.RegisterAttachment` | Invocable | Register a file as pending, or bound to a running turn's conversation. |
| `AiConversation.ReadAttachment` | Invocable | A file's record: the conversation holding it, its name. |
| `AiConversation.ExpireAttachments` | Invocable | Release expired pending files; list released ones. |
| `AiConversation.ForgetAttachments` | Invocable | Delete the records of released files. |

Exact inputs, outputs and codes: [operations](./docs/operations.md). The contract a backend implements: [store contract](./docs/store-contract.md).

## Example

```yaml
imports:
  AiConversation: oci://ghcr.io/telorun/ai-conversation@<version>
  AiConversationSql: oci://ghcr.io/telorun/ai-conversation-sql@<version>
---
kind: AiConversationSql.Store
metadata: { name: store }
connection: !ref db
---
kind: AiConversation.Append
metadata: { name: append }
store: !ref store
```
