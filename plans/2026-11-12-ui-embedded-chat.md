---
status: draft
priority: high
depends-on: [2026-11-12-auth-visitor.md, 2026-11-12-ui-composable-pages.md]
packages: [modules/ui, modules/ui-react, modules/ui-embed, modules/conversation, modules/ai-chat, modules/ai-conversation, modules/ai-conversation-sql, examples/chat, apps/authoring-agent, apps/hub, docs]
refinement: not-started
---

# Embedded chat and support widget

## Problem

A Telo chat cannot be put on another site. `UiReact.App` owns the whole document: its shell, its history and its address. There is no way to embed one view, and no corner launcher opening a chat window. A host cannot tell the chat anything either, such as the product a visitor is looking at, or who is signed in.

The chat API is also open to every caller. `Chat.Api` lists, reads, renames, archives and deletes every conversation, and streams, cancels and serves the attachments of every turn, for anyone who can reach it. On a public page, every visitor would read everyone else's conversations.

## Surface

**Added**

`ui-react`:
- `UiReact.Embed`: a mount serving one view for an iframe. Fields: `title`, `theme`, `tokens`, `stylesheets`, `compactBelow`, `content` (nodes evaluated per request, panes included), `parameters` (one JSON Schema per name), `frameAncestors` (origins allowed to frame it, or `*`; required) and `visitor: { issue }` (the app-relative address of the visitor issuing route).
- The `parameters` browser root inside an embed's `content`, and `request.parameters` in its per-request contexts.
- `<mount>/_telo/ui/embed`: the embed document.
- The `Content-Security-Policy: frame-ancestors …` header on the embed's shell.

`ui`:
- `Ui.Chat.context`: a map of accessors, sent with every message.
- `Ui.Chat.conversation.state`: `{ key, store }`, keeping the open conversation in a `Ui.StateStore`.
- `UI_CHAT_CONTEXT_UNDECLARED` / `ERR_UI_CHAT_CONTEXT_UNDECLARED`.

`ui-embed` (new module, `UiEmbed`):
- `UiEmbed.Frame`: a mount serving `<mount>/loader.js`, which places an iframe of `open` inside a host element.
- `UiEmbed.Launcher`: a mount serving `<mount>/loader.js`, which draws a corner button and opens `open` in a window. Fields: `open`, `icon` (a `Ui.Icon`), `label` (a `Text`), `corner` (`bottom-end` by default, `bottom-start`, `top-end`, `top-start`), `window: { width, height }`, `state: { key, store }` (whether the window was left open), `tokens` (a `Ui.DesignTokens` for the button).
- Loader attributes: `data-target` (Frame), `data-parameter-<name>` (each becomes a query parameter of the iframe address), `data-token-provider` (the name of a host function answering a token).
- The message contract `ui_embed-1`, shipped as data files with vectors: `ready`, `token`, `token-request`.

`conversation`:
- `Conversations.Conversation.context`: a `Telo.Type` reference.
- `Conversations.TurnRequest.context`.
- `claim` in `Conversations.Operations`.

`ai-chat`:
- `Chat.Api.claim`: an `Auth.Verifier` whose visitors' conversations a signed-in caller may take over.
- The route `POST <base>/claim`, answering `{ claimed }`.
- `ERR_CONVERSATION_CLAIM_REFUSED` (403).
- A required, nullable `owner` input on every `ai-chat` operation kind.

**Changed**
- `UI_PAGE_UNROUTED` also covers `UiReact.Embed`, which serves no page, so any page reference reachable from an embed is refused.
- `AiConversation.Store`: every method takes the caller's owner, and a conversation or attachment owned by someone else reads as absent.
- The user entry in the store keeps the message's `context`.

**Removed**
- None.

## Solution

**Delivery is an iframe.** Styles stay apart in both directions. The shell and its import map run unchanged inside the frame, so a host's own React, bundler or router never meets Telo's. Inside the frame the viewport is the frame, so `compactBelow` applies to the window's own width.

`UiReact.Embed` serves its shell at its mount path, with `frame-ancestors` taken from `frameAncestors`. Its documents are requested with the frame's declared parameters. A link inside the embed opens in a new tab, because following it would replace the chat.

**Parameters are untrusted context, typed.** The host sets them in the iframe address: written directly in an `<iframe src>`, or through `data-parameter-<name>` attributes, which the loader copies into the address. Changing an attribute reloads the frame. Each declared parameter is optional, and a value failing its schema is treated as absent on both sides (reported in the console). In the browser it is the `parameters` root. On the server it is `request.parameters`, which per-request `when`s and token choices may read, keyed into the document digest and `Vary` like any request value. Identity is never a parameter.

**Identity travels in headers set by the embed.** The loader calls the host's `data-token-provider` function and sends the host's token over `token`. The embed accepts a message only from its parent, and only from an origin `frameAncestors` allows. Tokens never ride in an address.

On every app-relative request, attachment media included, the embed sends `Authorization: Bearer <host token>` when it holds one. Otherwise it sends `Visitor-Token`, which it gets from `visitor.issue` and keeps in the frame's own storage. A 401 with a host token sends `token-request`, and the host's next `token` retries the request. A 401 with a visitor token gets a fresh one from `visitor.issue`. When a host token arrives while the embed holds a visitor token, the embed calls the conversation's `claim` with both, then drops the visitor token.

**Conversations have owners.** The owner is the caller principal's (issuer, subject), or null with no principal. Owners are strict partitions: a caller with a principal never sees an unowned conversation, and a caller without one sees only unowned ones. Anything owned by someone else reads as `ERR_CONVERSATION_NOT_FOUND`. This holds for listing, reading, renaming, archiving, deleting, starting a turn, streaming and cancelling a turn, and reading or attaching an upload. Turn events and cancelling are checked against the conversation's current owner in the store.

A claim requires a caller principal and a `Visitor-Token` that `Chat.Api.claim` accepts. It is refused when the caller is itself a visitor of that verifier. It moves the visitor's conversations and attachments one conversation per write, so a repeated or interrupted claim moves nothing twice.

**Context reaches the model as part of the message.** `Ui.Chat.context` binds each property of the conversation's `context` type from the roots in scope (`parameters`, `query`, `params`). Every required property must be bound, and the map is checked against the type before the app runs. Each send carries the current values, which are held to the type (a 400 at `/body/context…`) and stored with the user's entry. When the history is sent to the model, an entry carrying context leads with one text part: `<context>` + its canonical JSON + `</context>`, keys in the type's order. The system prompt never changes, so its cached prefix holds and untrusted values never gain instruction authority; the agent's own `system` explains the envelope.

**The widget is renderer-free.** `ui-embed` imports `ui` only (for `Ui.Icon`, `Ui.StateStore` and `Ui.DesignTokens`), and its loaders are plain DOM, the launcher's button drawn in a shadow root. The widget reopens the conversation after host navigation through `Ui.Chat.conversation.state`. Each kind names what it opens by an address, absolute or relative to the loader's own origin.

## Decisions

- **Parameters in the address, the token only by message.** The server must read parameters, and a token in a URL leaks into logs and `Referer`.
- **Context in the user turn, not the system prompt.** A runtime system prompt replaces the agent's own, breaks prompt caching on every message, and promotes host data to instructions.
- **Ownership lives in the store and the operation kinds, not the wire contract.** A client never names an owner.
- **The claim is explicit and proven by both credentials.** Without it, a visitor who signs in mid-chat loses the conversation.
- **Addresses, not references, between the two modules.** A mount cannot learn another mount's path, and a reference would tie a renderer-free module to `ui-react`.
- **`frameAncestors` is required.** Framing by any site is something an author writes, never a default.

Bookkeeping:
- **Docs:** a new `ui-react` `embed.md`; `ui-react` `urls.md` for the embed document; `ui` `chat.md` for `context` and `state`; the `ui-embed` docs and README with the `ui_embed-1` contract; `conversation`'s `conversation-contract.md`; `ai-chat` `api.md`, `conversation.md` and `history.md` (the envelope); `ai-conversation` and `ai-conversation-sql` docs on ownership.
- **Example:** `examples/chat` gains a demo host page served by `Http.Static`, embedding the launcher and opened with `Telo.OpenUrl`, with tests under its `tests/` (two visitors isolated, the claim, context reaching the model).
- **Release:** ledger entries, "Chat on any site, as a window or a widget" and "Conversations private to each visitor"; the primer and the hub `build-ui` guide; `license: MIT` and `LICENSE` for `ui-embed`; `Added` fragments per module; `telo release floor`.

## Verify

- A host page on another origin listed in `frameAncestors` frames the embed. One not listed is refused by the browser, per the header.
- `<iframe src=…?product=x>` and a `UiEmbed.Frame` with `data-parameter-product="x"` and no token draw the same chat. `request.parameters.product` reads `x` on the server; `product=7` against a `type: string, enum: [x]` schema is absent on both sides.
- A message from a disallowed origin changes nothing.
- Two visitors in two browsers each list only their own conversations. Reading, streaming, cancelling or fetching an attachment of the other's answers 404.
- A signed-in host user sends `Authorization` and sees their own conversations. After signing in mid-chat, the claim moves the visitor's conversation, and a second claim moves nothing. A claim by a visitor, or without a valid `Visitor-Token`, is `ERR_CONVERSATION_CLAIM_REFUSED`.
- An expired host token triggers `token-request`, and the chat continues with the new token.
- `Ui.Chat.context` binding a property the type lacks, or leaving a required one unbound, fails `telo check`. A chat over a conversation with no `context` that writes one is `UI_CHAT_CONTEXT_UNDECLARED`.
- Two replays of one conversation send byte-identical model input, and an edited branch carries the context of its own send.
- The launcher reopens the same conversation, open or closed as left, after the host page navigates.

## Example after the change

```yaml
kind: UiReact.Embed
metadata: { name: supportChat }
title: Support
theme: !ref UiReact.defaultTheme
frameAncestors: ["https://shop.example.com"]
parameters:
  product: { type: string }
visitor: { issue: /api/visitor }
content:
  - type: composite
    ref:
      kind: Ui.Chat
      source: { kind: Ui.ConversationSource, conversation: !ref conversation, basePath: /api/chat }
      conversation: { state: { key: support, store: { kind: Ui.LocalStore } } }
      context: { product: !cel "parameters.product" }
---
kind: UiEmbed.Launcher
metadata: { name: supportWidget }
open: /support
icon: { kind: UiLucide.Icon, name: message-circle }
label: Chat with us
window: { width: 24rem, height: 36rem }
state: { key: support, store: { kind: Ui.LocalStore } }
```

On the host page: `<script src="https://chat.example.com/widget/loader.js" data-parameter-product="kettle" data-token-provider="getChatToken" async></script>`.
