# Conversation

`conversation` (module `Conversations`, imported as `Conversation`) is the
contract every server and client of a chat speaks. It imports only `data-model`
(for the conversation list's collection), so an agent behind a chat endpoint and a
screen that draws one agree on it without depending on each other.

## What it holds

- **`Conversation.Conversation`** — abstract `Telo.Provider`: a conversation
  endpoint. A kind extending it publishes a `Conversation.Spec` as its reading
  (`operations` — `branch`, `cancel` — and `attachments` when it takes any), so a
  client draws only the controls the endpoint offers.
- **`Conversation.conversations`** — the `DataModel.Collection` over
  `ConversationSummary` that `GET /conversations` speaks: filters `title`
  `contains` and `archived` `eq`, sort `updatedAt`. A page lists conversations
  through a `Ui.CollectionSource` over it.
- **Shapes**, each a named `Telo.JsonSchema` exported as a resource:
  - `Spec` (built from `AttachmentOffer` and `Operations`) — what an endpoint
    offers before any event arrives.
  - `Event` — the closed union of streamed events, discriminated by `type`.
    Built from `Part` (a completed piece of a message) and `Usage`.
  - `Entry` — one transcript entry as a viewer reads it: its turn, its place among
    its siblings and its tool calls' approvals.
  - The route bodies: `TurnRequest`, `TurnStarted`, `ConversationSummary`,
    `ConversationPage`, `EntryPage`, `ConversationPatch`, `Attachment`, and
    `Problem` for every failure.

The routes, their bodies, the event stream and the problems are in
[docs/conversation-contract.md](docs/conversation-contract.md).

## Using the shapes

A shape is a named type: `inputType: !ref Conversation.Event` binds a contract to
it, and `$ref: "telo:Conversations/Spec"` names it from a kind's schema. A kind
that extends `Conversation.Conversation` declares `attachments` and `operations`
in its own schema (with the `AttachmentOffer` and `Operations` shapes); they are
its published reading.
