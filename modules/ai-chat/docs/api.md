# `Chat.Api`

> Examples assume this module is imported as `Chat` (the module is named `AiChat`, and the alias must differ from that for now), `http-server` as `Http`.

`Chat.Api` mounts the conversation contract (`conversation/docs/conversation-contract.md`) over HTTP for one `Chat.Conversation`. It names the conversation and never the page: a `Ui.ConversationSource` whose `basePath` is the mount's path, over the same conversation, is what draws it.

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /api/chat
    mount: { kind: Chat.Api, conversation: !ref conversation }
```

Every route only translates: the request becomes the input of one operation kind, its result becomes the response, and its failures become problems. The operations are the module's own invocables, so a queue worker or a test calls the same ones.

## Routes

| Route | Operation | Success |
| --- | --- | --- |
| `GET /capabilities` | `Chat.Capabilities` | 200 `Conversation.Spec` |
| `POST /turns` | `Chat.StartTurn` | 200 `{ conversation, turn }` |
| `GET /turns/{id}/events` | `Chat.TurnEvents` | 200 `text/event-stream` |
| `POST /turns/{id}/cancel` | `Chat.CancelTurn` | 200 `{ outcome }` — `requested` or `ended` |
| `GET /conversations` | `Chat.ListConversations` | 200 `ConversationPage` |
| `GET /conversations/{id}` | `Chat.ReadConversation` | 200 `ConversationSummary` |
| `GET /conversations/{id}/entries` | `Chat.ConversationEntries` | 200 `EntryPage` |
| `PATCH /conversations/{id}` | `Chat.UpdateConversation` | 200 `ConversationSummary` |
| `DELETE /conversations/{id}` | `Chat.DeleteConversation` | 204 |
| `POST /attachments` | `Chat.PutAttachment` | 200 `Attachment` — `{ id, mediaType, size }` |
| `GET /conversations/{id}/attachments/{attachmentId}` | `Chat.GetAttachment` | 200 the bytes |

`GET /conversations` speaks the collection contract against `Conversation.conversations`: `title.contains`, `archived`, `sort` (`updatedAt` or `-updatedAt`, the default), `limit` (1–100, 25 when absent) and `cursor`, answering `{ rows, total, next }`. Any other query parameter, an unlisted sort and a `limit` outside 1–100 are a 400 with their issue under `/query` (`/query/title.eq`, `/query/sort`, `/query/limit`); `q` is retired. The entries route takes `through`, `limit` and `cursor`. The request bodies of `POST /turns` and `PATCH /conversations/{id}` are declared on their routes, so a body the contract refuses is answered by the route itself, with its issues under `/body` (`/body/message` for a message beside approvals).

Every route is served whether or not the spec lists an operation: the spec lists only `branch` and `cancel`, and a client reads it to know whether to offer them.

## Sending a turn

`POST /turns` takes the `TurnRequest`. An `idempotency-key` header (1–255 characters) is passed as `idempotencyKey`; a malformed one is a 400 with its issue at `/headers/idempotency-key`. How long a key is remembered is the journal's `retention`, applied only while `RecordStream.JournalExpiry` runs over the journal on a schedule.

## The event stream

`GET /turns/{id}/events` answers `text/event-stream`. Each event is one frame:

```
id: 3
event: step-usage
data: {"type":"step-usage","usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}
```

The frame's `id` is the event's position in the turn, its `event` the event's `type`, and its `data` the whole event (a `tool-call` keeps its own `id` member there). Without `Last-Event-ID` the stream replays from the start; with it, from the position after. A malformed `Last-Event-ID` is a 400 at `/headers/last-event-id`. A turn whose events are unknown or past retention is a 404 before the stream starts. A turn id that is not a `trn_` id is a 400 at `/params/turnId`, as an attachment id that is not an `att_` id is at `/params/attachmentId` on the file route. A failure after it has started cannot change the status, so the stream ends with one last frame and the response completes:

```
event: error
data: {"type":"error","code":"ERR_CONVERSATION_TURN_NOT_FOUND","detail":"No turn 'trn_…' is known, or it is past retention; read the conversation's entries instead."}
```

It has no `id`, `code` is the failure's code — `INTERNAL_ERROR` for a failure that carries none — and `detail` its message; the failure is also logged at `error`. A cancelled or suspended read is not answered this way: its stream ends as the encoder ends any failed stream.

The route is built from public kinds: `Stream.Map` makes each event a frame, `Stream.Recover` writes the final one, and `Sse.Encoder` writes the bytes.

## Uploading

`POST /attachments` takes a `multipart/form-data` body; the file is the first part named `file` (read with `Multipart.ReadPart`): the parts before it are discarded and the rest of the body is not read, so anything else an upload is bound to travels in the URL, never as another form field. The part is streamed — detected from its leading bytes, then written to the file store under its type's bound — so an upload costs one chunk of memory, not its size.

- The part's `Content-Type` is a claim the bytes must not contradict. A part sent as `application/octet-stream` (what a client sends when it does not know) makes no claim.
- The route's `maxBodyBytes` is the largest `maxBytes` among the spec's accepted types plus 64 KiB for framing (64 KiB alone when the endpoint accepts no attachments). A body larger than that is the server's 413. A file larger than its own type's bound but within the body limit is refused as a 400 and stores nothing.
- A file of a type outside the spec's `attachments.accepts`, one its content contradicts, and any upload to an endpoint that accepts none are 400 `ERR_INPUT_INVALID` problems with an issue at `/body/file`. A body with no `file` part is a 400 `ERR_MULTIPART_PART_MISSING` problem with a `required` issue at `/body/file`.

An upload is pending: it has no address, belongs to no conversation, and is bound to the conversation of the first admitted turn naming it. A turn naming one that is unknown, expired, deleted or bound to another conversation is a 400 at `/body/attachments/<i>`, and one naming an id twice is refused by the route at `/body/attachments`. A client shows a file it is about to send from its own copy.

`GET /conversations/{id}/attachments/{attachmentId}` streams the stored bytes of a file the conversation holds as `application/octet-stream`: a route's content type is fixed by its declaration, so the stored media type is not sent. Pages draw an attachment by what the entry says it is, so this changes nothing a browser draws. Under any other conversation, while it is pending, and once its conversation is deleted, the read is a 404 `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` with `data: { attachment }`, the same answer for each so an id reveals nothing about where it is held. There is no route reading a file by its id alone.

## Problems

Every failure is an `application/problem+json` document with `status`, `code`, `detail` and `data`.

| Code | Status |
| --- | --- |
| `ERR_INPUT_INVALID` | 400, issues under `/body`, `/headers` or `/query` |
| `ERR_MULTIPART_PART_MISSING` | 400, a `required` issue at `/body/<part>` |
| `ERR_CONVERSATION_CURSOR_INVALID`, `ERR_MULTIPART_MALFORMED`, `ERR_MULTIPART_LIMIT_EXCEEDED` | 400 |
| `ERR_CONVERSATION_NOT_FOUND`, `ERR_CONVERSATION_ENTRY_NOT_FOUND`, `ERR_CONVERSATION_TURN_NOT_FOUND`, `ERR_CONVERSATION_ATTACHMENT_NOT_FOUND` | 404 |
| `ERR_CONVERSATION_TURN_RUNNING`, `ERR_CONVERSATION_CONFLICT` | 409 |
| `ERR_IDEMPOTENCY_KEY_CONFLICT` | 422 |
| `ERR_CONVERSATION_UNAVAILABLE` | 503 |

Anything else is the server's 500 problem. A body past `maxBodyBytes` is the server's own 413.

## Owning the routes

`Chat.Api`'s body names only kinds an importer can name — this module's exported operations and the public kinds of `http-server`, `stream`, `sse-codec`, `multipart` and `octet-codec` — so an application that needs to change a route can copy the body into a library of its own, the endpoint taken as a resource input. `tests/__fixtures__/ejected-api` is exactly that copy, every route test runs against it as well as against the kind, and a unit test fails when the two drift apart.

## Several replicas

Replicas that share the store and the journal serve one conversation alike: a turn started on one is followed, resumed and cancelled from another, and a send repeated under one key to two of them starts one turn. See [Turns](turns.md).
