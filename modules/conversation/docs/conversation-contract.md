# The conversation contract

What a chat server answers and a chat client speaks. Every path below is under
the base path the client is given for the endpoint (`<base>/turns`, …). The
shapes named here are exported by this module: `Conversation.Spec`,
`Conversation.Event`, `Conversation.Entry`, and the request and response bodies.

## Routes

| Route | Meaning |
| --- | --- |
| `GET /capabilities` | the endpoint's `Conversation.Spec`, for clients that do not receive it another way |
| `POST /turns` | `TurnRequest` → `TurnStarted` (`{ conversation, turn }`) |
| `GET /turns/<id>/events` | server-sent events of `Conversation.Event` |
| `POST /turns/<id>/cancel` | stops a running turn (`cancel`), on whichever replica runs it |
| `GET /conversations` | a page `ConversationPage`, as the collection `Conversation.conversations` declares (below) |
| `GET /conversations/<id>` | the `ConversationSummary` of one conversation |
| `GET /conversations/<id>/entries` | a page `EntryPage` of one branch's transcript, newest first; `?through=<entry id>` chooses the branch |
| `PATCH /conversations/<id>` | `ConversationPatch` — `{ title?, archived? }`; answers the updated summary |
| `DELETE /conversations/<id>` | deletes the conversation; answers 204 |
| `POST /attachments` | a `multipart/form-data` upload of one file → `Attachment` (`{ id, mediaType, size }`) |
| `GET /conversations/<id>/attachments/<attachment id>` | the stored bytes of a file the conversation holds |

Only `cancel` and `branch` belong to an operation of the spec: an endpoint that
does not list one need not serve its route. `branch` is the choice of `parent` in
a turn and of `through` in the entries. Every other route is served whatever the
spec lists.

## The spec

`Conversation.Spec` is what an endpoint offers before any event arrives:

- `attachments`, absent when the endpoint takes none:
  `{ accepts: [{ type, mediaTypes, maxBytes }], maxPerMessage }`, `type` one of
  `image`, `audio`, `video`, `file`.
- `operations`: the subset of `branch` and `cancel` the endpoint supports.

## Starting a turn

`POST /turns` with `{ conversation?, parent?, message, attachments, approvals? }`:

- `conversation` continues a conversation; absent, one is started.
- `parent` is the entry the message follows. A conversation is a forest:
  - **absent**: the message follows the conversation's latest-appended entry (the
    latest branch); in a new conversation it is a root.
  - **`null`**: a new root, a sibling of the existing roots.
  - **an entry id**: the message follows that entry, which must belong to the
    conversation; otherwise `ERR_INPUT_INVALID` with its issue at `/body/parent`.
    A string `parent` without `conversation` is refused the same way.
  - An endpoint that does not offer `branch` refuses `null`, and any id other than
    the latest-appended entry, while the conversation has entries.
- `attachments` are the ids returned by `POST /attachments`, in order, each at
  most once. Each must be a pending upload or a file this conversation already
  holds (a retry, an edit, a regenerate); an id that is unknown, expired,
  deleted or held by another conversation is `ERR_INPUT_INVALID` with its issue
  at `/body/attachments/<i>`. The first admitted turn naming a pending upload
  binds it to the conversation.
- `approvals` — `[{ id, approved, reason? }]`, at least one — resumes a turn that
  ended with `reason: approval`, one decision per `approval-request` event, with
  `parent` the entry holding the calls. Beside `approvals` the `message` is `""`
  and `attachments` is `[]`; anything else is `ERR_INPUT_INVALID` at
  `/body/message` or `/body/attachments`. A turn whose parent has an undecided
  approval must decide every one, else `ERR_INPUT_INVALID` at `/body/approvals`.

The answer is `{ conversation, turn }`. A turn already running on the
conversation is a 409 `ERR_CONVERSATION_TURN_RUNNING`.

An `idempotency-key` header (1–255 characters) makes a retried send start one
turn: a send repeating a key answers the `{ conversation, turn }` the first one
started. A send whose first attempt was refused is attempted again. A key reused
with a different body — another `conversation`, `parent`, `message`,
`attachments` or `approvals` — is a 422 `ERR_IDEMPOTENCY_KEY_CONFLICT`, and so is
a key the endpoint has stopped remembering: send a new key. How long a key is
remembered is the endpoint's own retention of ended turns. A malformed header is
`ERR_INPUT_INVALID` at `/headers/idempotency-key`. Nothing may follow an entry whose approvals are
undecided: a store refuses an append beneath one, and a second decision of one
approval, with `ERR_CONVERSATION_CONFLICT` (409).

## The event stream

`GET /turns/<id>/events` answers `text/event-stream`. Each frame's `event` is the
event's `type`, its `id` the resume position, and its `data` the event as JSON. A
client that lost the connection reconnects with `Last-Event-ID` and receives the
frames after that position; a finished turn replays to its `turn-end`. A turn whose
journal is unknown or past retention answers 404 `ERR_CONVERSATION_TURN_NOT_FOUND`;
a client then re-reads the branch.

`Conversation.Event` is a closed union on `type`:

| `type` | Carries |
| --- | --- |
| `text-delta` | `text`, the next piece of the answer |
| `reasoning-delta` | `text`, the next piece of the model's reasoning |
| `content` | `part`, a completed part: media by attachment URL, a citation, a refusal |
| `tool-call-delta` | `id`, `name?`, `argumentsDelta`, the arguments as they are written |
| `tool-call` | `id`, `name`, `arguments`, the finished call |
| `tool-result` | `id` (the call), `result`, `isError?` |
| `approval-request` | `id`, `toolCallId`, `name`, `arguments`: a call waiting for a decision |
| `approval-decision` | `id`, `approved`, `reason?` |
| `step-usage` | `usage` of one model step |
| `turn-end` | `reason`, `usage?`; the last event of a turn |
| `error` | `code`, `detail`, `data?`, read like a problem |

`turn-end.reason` is `stop`, `length`, `content-filter`, `limit`, `approval`,
`cancelled` or `failed`. A turn ending with `approval` is resumed by a
`POST /turns` carrying `approvals`.

The contract grows only by adding event types; **a client ignores a type it does
not know**. A member of a known type is never repurposed.

## Conversations and entries

`GET /conversations` speaks the collection contract against
`Conversation.conversations`, a `DataModel.Collection` over `ConversationSummary`
(key `id`) that lists the filters `title` `contains` and `archived` `eq` and the
sort `updatedAt`. It takes `title.contains=<text>`, `archived=<true|false>`,
`sort=updatedAt` or `sort=-updatedAt` (the default), `limit` (1–100, 25 when
absent) and `cursor`, and answers `{ rows, total, next }` of `ConversationSummary`
(`id`, `title`, `archived`, `updatedAt`, `turn`, `running`), `next` the cursor of
the following page or `null`. Any other filter or sort is a 400
`ERR_INPUT_INVALID`, as the collection contract refuses it. A page composes the
list as a `Ui.Listing` over a `Ui.CollectionSource` for that collection. `turn` is the latest admitted turn (`null` when
none); `running` is true only while that turn is open (judged from its journal after
the stale-writer rule), false when `turn` is `null`. `GET /conversations/<id>`
answers the same summary.

### Entries

`Conversation.Entry`: `id`, `parent` (`null` for a root), `turn` (the `trn_…` id of
the turn that appended it), `siblings`, `role`, `parts` (media by URL), `toolCalls`,
`toolResults`, `usage`.

- `siblings` is `{ position, count, previous, next }`: the entry's 1-based place
  among the entries sharing its parent, in append order (roots are siblings of each
  other), and the neighbours' ids (`null` at either end). It is the same whichever
  branch the entry is read through.
- A tool call that needed a decision carries `approval: { id, decision }`, `id` the
  `approval-request` / `approval-decision` id and `decision` `null` while pending,
  else `{ approved, reason? }`. It records a human's decisions and an approver's
  in-turn decisions alike. A call that needed none has no `approval`.

`GET /conversations/<id>/entries` takes `limit` and `cursor` and answers
`{ rows, total, next }` of entries. It is one sequence from the leaf toward the root
(newest first): the first page holds the newest `limit` entries, rows within a page
follow the same order, and `next` continues toward the root. The cursor is opaque.
`total` is the branch length.

The branch is chosen by `?through=<entry id>`: from the root down to that entry,
then below it by the most recently appended child at each step, down to a leaf.
Without it the branch is the **latest branch**, the one ending at the conversation's
most recently appended entry (the entry a turn follows when `parent` is absent).
A client switching to a sibling requests `?through=<sibling id>` and may stop paging
once it reaches an entry it already has.

### Reopening a conversation

1. `GET /conversations/<id>` for the summary.
2. Read the latest branch, paging leaf to root, and reverse each page before putting
   it above what is drawn.
3. If `running`, set aside the entries whose `turn` equals the summary's `turn`.
4. Tail `GET /turns/<turn>/events` with no `Last-Event-ID` and draw it as the live
   turn. A live `tool-result` for a call already in a stored entry is added to that
   entry.
5. On `turn-end`, read the branch again.

A turn that ended waiting on approval shows after a reload as tool calls with
`decision: null` on the branch's last entry; the client draws approval cards and
resumes with `POST /turns` carrying `approvals` and `parent` that entry.

## Attachments

`POST /attachments` takes one file as `multipart/form-data` and answers
`{ id, mediaType, size }`; the file is refused when its type or size is outside
the spec's `attachments.accepts`. An upload is **pending**: it belongs to no
conversation and has no address. The first admitted turn naming it binds it to
that turn's conversation, and from then on only that conversation may name it.
An upload no turn sends is removed after the endpoint's own retention, and a
deleted conversation's files are unreadable at once.

A bound file is read at `GET /conversations/<id>/attachments/<attachment id>`,
and nowhere else: under any other conversation, and while it is pending, the read
is a 404 `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND`. Its `url` — in a `content`
event and in an entry's parts — is the relative reference
`conversations/<id>/attachments/<attachment id>`. A client resolves it against
the endpoint's base (`<base>/`), so the server never needs to know the path it
is served at. Any other media `url` is absolute. A client shows a file it is
about to send from its own copy, since a pending upload has no address.

## Problems

Every failure is an RFC 9457 problem (`application/problem+json`, shape
`Problem`): `status`, a `code`, a `detail`, and `data` when the code has any. A
refused request is `ERR_INPUT_INVALID` with `data.issues`.

| Code | Status | When |
| --- | --- | --- |
| `ERR_INPUT_INVALID` | 400 | The request is refused; `data.issues` point into it (`/body/parent`, `/body/attachments/<i>`, …) |
| `ERR_CONVERSATION_NOT_FOUND` | 404 | No conversation has the id |
| `ERR_CONVERSATION_TURN_NOT_FOUND` | 404 | Events or a cancel for a turn that is unknown or past retention |
| `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` | 404 | The conversation holds no file with the id — unknown, pending, deleted or another conversation's alike; `data: { attachment }` |
| `ERR_CONVERSATION_TURN_RUNNING` | 409 | A turn is already running on the conversation |
| `ERR_CONVERSATION_CONFLICT` | 409 | A concurrent change won, an append beneath an undecided approval, or a second decision |
| `ERR_IDEMPOTENCY_KEY_CONFLICT` | 422 | An `idempotency-key` reused with another body, or no longer remembered |
