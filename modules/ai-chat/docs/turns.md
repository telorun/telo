# Turns

> Examples assume this module is imported as `Chat` (the module is named `AiChat`, and the alias must differ from that for now).

## `Chat.StartTurn`

Input: the conversation contract's `TurnRequest` — `{ conversation?, parent?, message,
attachments, approvals? }` — plus `idempotencyKey?` (1–255 characters). Output:
`TurnStarted`, `{ conversation, turn }`, answered once the turn is admitted; the agent
runs in the background.

### Admission

One round, retried at most three times:

1. The conversation is created (no `conversation`) or its header read. A first
   message is held to the request rules below before the conversation is created, so
   a refusal leaves no conversation behind.
2. The header's `turn` is read from the journal (`RecordStream.JournalRead`, whose
   stale-writer rule fails a dead writer's key). An open key is
   `ERR_CONVERSATION_TURN_RUNNING`.
   The check is per conversation: turns of different conversations run at the same
   time on one instance.
3. The request is held to the stored branch (below).
4. The new turn's key (`trn_…`) is claimed under a writer token
   (`RecordStream.JournalClaim`), then admitted by `AiConversation.Admit` at the
   version read, which binds the message's attachments to the conversation in the
   same write. A version conflict removes the claimed key
   (`RecordStream.JournalRemoval`) and starts the next round under a new turn id; an
   attachment bound or released since step 3 removes it and refuses the request at
   `/attachments/<i>`, as step 3 would have.

After three conflicting rounds the call is `ERR_CONVERSATION_CONFLICT`.

### What a request may say

Each refusal is `ERR_INPUT_INVALID`, its issue pointer relative to the input:

| Request | Refused at |
| --- | --- |
| A string `parent` without `conversation` | `/parent` |
| A `parent` the conversation does not hold | `/parent` |
| `approvals` when the parent has none undecided, or a parent with undecided approvals and no `approvals`, or not every one decided | `/approvals` |
| An `approvals` entry naming no undecided approval of the parent | `/approvals/<i>` |
| More attachments than `maxPerMessage` | `/attachments` |
| An attachment that is unknown, expired, deleted or held by another conversation — one message for all four — or of a type no longer offered, or over its type's bound | `/attachments/<i>` |
| An attachment named twice | the input contract |
| A non-empty `message`, or attachments, beside `approvals`; an empty `approvals` | the input contract |

The last row is the input contract's own (`Conversation.TurnRequest`); a contract
refusal carries no issue list today, so a transport validating its body against the
shape first reports the issues itself. An unknown `conversation` is
`ERR_CONVERSATION_NOT_FOUND`.

`parent` absent follows the conversation's latest-appended entry; `null` starts a new
root; an id follows that entry.

### The run

The admitted turn runs detached, drained into its journal key by `RecordStream.JournalSink`
under the writer token that claimed it:

1. Human decisions in `approvals` are recorded (`AiConversation.RecordApproval`).
2. Without approvals, the user message is appended: its text, then each attachment by
   reference (`attachment:<id>`, with its type, media type and file name).
   An attachment may be named while it is pending (uploaded within
   `attachments.pendingRetention`, sent by no turn) or once this conversation holds
   it; its record is read from the store and its type and size from the file store.
3. The branch from its root to the parent — plus the new message — is the agent's
   `messages`, each attachment loaded into a `data` part from the file store; the
   decisions are its `approvals`.
4. Each agent part becomes its event (below) and is journaled. Each `message` part is
   appended to the store as it commits, after every event before it was journaled.
   Media bytes the agent produces — in a `content-part`, a tool result or a message —
   are kept as a new attachment first, since a stored message holds none: registered
   bound to the turn's conversation, then stored, so a `content` event's `url` reads
   as soon as the event does, however long the turn runs. A superseded turn's
   registration is refused, so it keeps nothing. An approval request or an approver's
   decision is recorded on the entry holding the call after its event is journaled.
5. The turn ends at its `turn-end` event: its key is finished once that event is
   journaled and every store append before it has committed, without waiting for the
   agent's stream to close, so a client may send or approve as soon as it has read
   `turn-end`.

Every turn loads the attachments of the whole branch into memory to send them to the
model, so a long branch of large files costs that much per turn.

### Parts and events

| Agent part | Event |
| --- | --- |
| `text-delta` / `reasoning-delta` | `text-delta` / `reasoning-delta` (`text`) |
| `content-part` | `content` (`part`; media bytes kept as an attachment) |
| `tool-call-delta` | `tool-call-delta` (`id`, `name`, `argumentsDelta`) |
| `tool-call` | `tool-call` (`id`, `name`, `arguments`) |
| `tool-result` | `tool-result` (`id`, `result` — the tool's output, else what the model was told — `isError`) |
| `step-finish` | `step-usage` (`usage`) |
| `tool-approval-request` | `approval-request` (`id` minted `apr_…`, `toolCallId`, `name`, `arguments`) |
| `tool-approval-decision` | `approval-decision` (`id`, `approved`, `reason`); a `defer` emits none — the request that follows names the call |
| `finish` | `turn-end` — `approval` for `interrupt: approval`, `limit` for `limit: max-steps`, else the finish reason (`stop`, `length`, `content-filter`; any other is `stop`) |
| `message`, `provider-state` | none |

Usage is `{ inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens }`,
each present when the model reported it.

## `Chat.TurnEvents`

Input `{ turn, after? }`; output `{ output }`, a stream of `{ id, event }` — the
position and the `Conversation.Event`. It holds each event recorded after `after`
(omitted: from the start), then follows the turn live until it ends. Every media
`url` naming an attachment reads `conversations/<conversation>/attachments/<id>`,
journaled so. An unknown or removed turn is
`ERR_CONVERSATION_TURN_NOT_FOUND`, raised by the call, or by the stream when the turn
is removed while it is read.

**An abnormal ending is derived from the key, never written by the writer.** After the
key's last record (`lastId`):

| The key | Closing events |
| --- | --- |
| failed with `ERR_JOURNAL_CANCELLED` | `lastId + 1`: `turn-end` `cancelled` |
| failed with any other error — `ERR_JOURNAL_WRITER_LOST`, `ERR_INVOKE_CANCELLED` from a shutdown, a failed run | `lastId + 1`: `error` (`code`, `detail`, `data`); `lastId + 2`: `turn-end` `failed` |

So a reader resuming from any position reads the same closing events.

## `Chat.CancelTurn`

Input `{ turn }`; output `{ outcome }` — `requested` for a running turn, `ended` for
one that already ended (a dead writer's key is failed as lost first). An unknown or
removed turn is `ERR_CONVERSATION_TURN_NOT_FOUND`. The writer sees the request at its
next write or through its wait on the key, ends the agent's stream — which aborts the
model call or the tools in flight — and fails the key with `ERR_JOURNAL_CANCELLED`.

## Shutdown

Tearing the endpoint down cancels each turn it is running: the agent's call fails
with `ERR_INVOKE_CANCELLED`, which the turn's key records, so a reader sees `error`
then `turn-end` `failed` — not `cancelled`, which is a user's stop.

## Idempotent sends

With `idempotencyKey`, admission is recorded on the journal key
`idempotency/<hex SHA-256 of the key>`: before any effect, an intent
`{ fingerprint, conversation, turn }` (the fingerprint a SHA-256 of the request's
canonical encoding; an absent and a `null` parent differ), one per admission round.

| The key | A send under it |
| --- | --- |
| never written | claims it and is admitted; the key finishes, or fails with the refusal's code |
| being admitted by another send | waits for that one to end, then reads again |
| finished | answers the recorded `{ conversation, turn }`; another request is `ERR_IDEMPOTENCY_KEY_CONFLICT` |
| failed — the first send was refused | is admitted again under the recorded ids (a new turn id if that turn's key was removed); another request is `ERR_IDEMPOTENCY_KEY_CONFLICT` |
| failed after its turn was claimed | answers that turn — unless the conversation never named it (the first send died between claiming the turn and admitting it), when a new turn is admitted |
| removed (expired) | `ERR_IDEMPOTENCY_KEY_CONFLICT`: send a new key |

A key is remembered as long as the journal keeps an ended key (`retention`), which takes effect only while the application runs `RecordStream.JournalExpiry` over the journal on a schedule; without one nothing expires.
