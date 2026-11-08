# AI Chat

A chat endpoint over a streaming AI agent: the conversation contract (`conversation`
module) served over an `Ai.AgentStream`, storing conversations through
`ai-conversation`, each turn's events in a `record-stream` journal and uploaded files
in a `blob` store.

## Why use this

- **Resumable turns on any replica** — a turn's events are journaled as they happen,
  so a reader on any replica replays them from any position and follows the turn live.
- **Stopped from anywhere** — a cancel reaches the turn's writer through the journal,
  wherever it runs; the agent's model call and tools in flight are aborted.
- **A dead writer is reported, not hung** — a turn whose writer stops heartbeating
  closes with an error and a failed ending once the journal's writer timeout passes,
  and the conversation takes a new turn.
- **Retried sends start one turn** — an idempotency key answers the turn the first
  send started, and refuses the key reused with another request.
- **Conversations name themselves** — with `titles`, a small model writes a short
  title for an untitled conversation as its turn ends; a rename is never overwritten.
- **Served as the conversation contract** — one mount gives a `Ui.Chat` page, or any
  client of the contract, its routes, problems and uploads.
- **Attachments the model can read** — an upload is detected from its bytes, held to
  what the agent's model accepts, and loaded for the model only when a turn calls it.
- **A file belongs to its conversation** — the first message sending an upload binds
  it to that conversation: no other conversation can send, read or delete it, deleting
  the conversation makes its files unreadable at once, and uploads no message sent are
  removed after `attachments.pendingRetention` by a scheduled `Chat.AttachmentExpiry`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Chat.Conversation` | The endpoint: its agent, store, journal, file store and detector, and the bounds on what a message carries. Publishes its `Conversation.Spec`. |
| `Chat.StartTurn` | Starts a turn; answers `{ conversation, turn }` at once while the reply is recorded. |
| `Chat.TurnEvents` | A turn's events from a position, then live until it ends. |
| `Chat.CancelTurn` | Stops a running turn from any replica. |
| `Chat.ListConversations` | A page of conversation summaries, filtered by title and archived state and ordered by last activity, as the conversation list collection declares. |
| `Chat.ReadConversation` | One conversation's summary. |
| `Chat.ConversationEntries` | A page of one branch's transcript, newest first. |
| `Chat.UpdateConversation` | Renames or archives a conversation. |
| `Chat.DeleteConversation` | Deletes a conversation, stopping its running turn first. |
| `Chat.PutAttachment` | Stores an uploaded file, pending until a message sends it. |
| `Chat.GetAttachment` | Reads a file back under the conversation holding it. |
| `Chat.AttachmentExpiry` | Removes unsent uploads past their retention and deleted conversations' files; run it on a schedule. |
| `Chat.Capabilities` | Answers, and publishes, what the endpoint offers. |
| `Chat.Api` | Mounts all of the above on an HTTP server as the conversation contract: JSON routes, a resumable event stream, multipart uploads and problem documents. |

The module's name is `AiChat`; import it under another alias (`Chat` here) — an alias equal to the module's name makes its private kinds unreachable for now.

Every operation kind takes one field, `conversation` — the `Chat.Conversation` it
works on — and knows no transport: an HTTP mount, a queue worker or a test sequence
calls them alike. `Chat.Api` is the HTTP transport over them.

## Example

```yaml
kind: Chat.Conversation
metadata: { name: conversation }
agent:
  kind: Ai.AgentStream
  model: !ref model
store: { kind: AiConversationSql.Store, connection: !ref db }
journal:
  kind: RecordStream.Journal
  store: { kind: RecordStreamSql.JournalStore, connection: !ref db }
  retention: 24h
blobs: { kind: BlobFs.Store, root: !cel "variables.stateDir.joinPath('attachments')" }
detector: { kind: MediaType.Detector }
attachments: { maxBytes: 10485760, maxPerMessage: 4 }
---
kind: Telo.Sequence
metadata: { name: ask }
steps:
  - name: started
    invoke: { kind: Chat.StartTurn, conversation: !ref conversation }
    inputs: { message: Hello, attachments: [] }
  - name: events
    invoke: { kind: Chat.TurnEvents, conversation: !ref conversation }
    inputs: { turn: !cel "steps.started.result.turn" }
```

The journal's `retention` is applied only while the application runs
`RecordStream.JournalExpiry` over it on a schedule (`Scheduler.Interval`); declare the
journal once and reference it from the conversation and the expiry. Files are removed
the same way, by `Chat.AttachmentExpiry` over the conversation on a schedule; without
it no file is ever removed.

Served over HTTP, where a `Ui.Chat` page reads the same conversation:

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /api/chat, mount: { kind: Chat.Api, conversation: !ref conversation } }
```

`examples/chat` is a complete application.

## Documentation

- [The HTTP API](docs/api.md) — routes, the event stream's framing, uploads and problems.
- [The conversation](docs/conversation.md) — the endpoint, what it offers, its bounds.
- [Turns](docs/turns.md) — admission, the run, events, cancel, abnormal endings,
  idempotent sends.
- [Conversations and attachments](docs/history.md) — reading and changing
  conversations, uploading and reading files.
