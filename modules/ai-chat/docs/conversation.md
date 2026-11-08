# `Chat.Conversation`

> Examples assume aliases `Chat` (this module; it must differ from the module's name `AiChat` for now), `Ai`, `AiConversationSql`,
> `RecordStream`, `RecordStreamSql`, `BlobFs` and `MediaType`.

A chat endpoint over a streaming agent. It extends `Conversation.Conversation` and
publishes the endpoint's `Conversation.Spec` — as `provide()` and as its reading — so
`Ui.ConversationSource` and `Chat.Capabilities` read the same offer.

| Field | Holds |
| --- | --- |
| `agent` | The `Ai.AgentStream` each turn runs. |
| `store` | The `AiConversation.Store` conversations and transcripts are kept in. |
| `journal` | The `RecordStream.Journal` each turn's events and each idempotency key are recorded in. |
| `blobs` | The `Blob.Store` uploaded files, and media a model or tool produces, are kept in. |
| `detector` | The `MediaType.Detector` an upload's type is read with. |
| `attachments` | `{ maxBytes, maxPerMessage, pendingRetention }` — defaults `10485760`, `4` and `24h`. |
| `titles` | Optional `{ model }`: an `Ai.Model` that [names untitled conversations](#titles). |

The conversation itself dispatches nothing: every operation kind reaches its store,
journal, file store, detector, agent and title model through it, each through the
kernel's dispatch (contracts, spans, cancellation).

## Titles

With `titles`, a turn that ends on a conversation with no title asks `titles.model`
for one, from the turn's user message and the reply's text (each cut at 2000
characters), and writes it before the turn's final `turn-end` event. A client that
reads the conversation again when the turn ends — `Ui.Chat` does, and so does a
listing it refreshes — sees the title at once.

- The title is the answer's first line with a `Title:` label, surrounding quotes or
  markup and a trailing stop removed, cut at a word to 80 characters; an empty
  answer writes nothing.
- A title already set is kept: the header is read before the model is asked and
  again before each write, so a rename that lands meanwhile wins. A conversation
  whose first turn wrote no title is named by its next turn.
- A failed title call ends nothing: the turn ends as it would have, and the failure
  is logged as a warning (`A conversation could not be titled`) with its code.
- It costs one model call per conversation, plus one header read per turn while
  the conversation is untitled; a small, fast model is enough.

```yaml
titles:
  model:
    kind: Anthropic.MessagesModel
    model: claude-haiku-4-5
    maxTokens: 32
    request: !ref anthropicRequest
```

## What it offers

- `attachments` is absent when the agent's model accepts nothing beside text
  (`resources.<agent>.accepts` is `[]`).
- Otherwise each of the model's `accepts` entries becomes an offered type, its
  `maxBytes` the smaller of the model's (when it sets one) and `attachments.maxBytes`;
  `maxPerMessage` is `attachments.maxPerMessage`.
- `operations` is `branch` and `cancel`. Reading, renaming, archiving and
  deleting a conversation are served whatever it lists.

A model declaring `[{ type: image, mediaTypes: [image/png], maxBytes: 5242880 },
{ type: file, mediaTypes: [application/pdf] }]` under the default bounds offers
images up to 5242880 bytes, PDFs up to 10485760, four per message.

## The journal's settings are the endpoint's

- `writerTimeout` is the only liveness setting: a turn whose writer stops
  heartbeating for that long is reported failed (`ERR_JOURNAL_WRITER_LOST`), and the
  conversation takes a new turn.
- `retention` is how long a finished turn's events can be replayed, and how long an
  idempotency key is remembered — applied only while the application runs
  `RecordStream.JournalExpiry` over the journal on a schedule; without one nothing
  expires. Declare the journal once and reference it from both the conversation and
  the expiry.

Two replicas over one database (store, journal and files through a shared backend)
serve one endpoint: everything a turn needs is in those three.

## Where files live

A file belongs to one conversation. Its record — the conversation holding it, the
name it was uploaded with — is kept in the `store`, its bytes under the `blobs` store
at `attachments/<id>`; no other key is written.

- **Pending.** An upload is registered before its bytes are stored, holding no
  conversation.
- **Bound.** The first admitted turn naming it binds it to that turn's conversation,
  in the admission's own write. Media a model or tool produces is registered bound to
  its turn's conversation before its bytes are stored, refused once another turn is
  current, so it reads under its URL as soon as the turn shows it and no expiry pass
  reaches it. From then on only that conversation may name or read it, and naming it
  again there (a retry, an edit, a regenerate) is allowed.
- **Released.** Deleting the conversation releases every file it holds in the same
  write, so none is readable afterwards. An upload no admitted turn named within
  `attachments.pendingRetention` (24h when omitted) is refused by the next turn naming
  it and released by the next expiry pass.

Stored messages refer to a file as `attachment:<id>`; an entry read back, a
`content` event and a tool result's media carry the relative reference
`conversations/<conversation>/attachments/<id>`, which a client resolves against the
endpoint's base. Events are journaled with it, since the events route knows only the
turn.

## Removing files

**Without a scheduled `Chat.AttachmentExpiry`, neither unsent uploads nor a deleted
conversation's files are ever removed** — they are unreadable, and they keep their
storage. Schedule one pass beside the journal's expiry:

```yaml
kind: Scheduler.Interval
metadata: { name: attachmentExpiry }
every: 1h
invoke: { kind: Chat.AttachmentExpiry, conversation: !ref conversation }
```

A pass releases the uploads past their retention, then for each released file —
those and a deleted conversation's — removes its bytes and then its record, 500 at a
time until a batch comes back short, and answers `{ count }`. A removal that fails
fails the pass, with the file still released, so the next pass finishes it; two
passes at once remove each file and both succeed. `attachments.pendingRetention` of
zero or less is refused, at check (`AI_CHAT_PENDING_RETENTION_NOT_POSITIVE`) and, as
`ERR_AI_CHAT_PENDING_RETENTION_NOT_POSITIVE`, when the conversation is created.
