# Ui.Chat

A full AI chat on a page. It is a [composite](composite.md) that draws one
conversation: its transcript, a message box and — only where the endpoint offers
it — an upload button. Which conversation it shows follows the page's address;
the list of past conversations is an ordinary [listing](listing.md) beside it
(see [A page of conversations](#a-page-of-conversations)).

| Field | | |
| --- | --- | --- |
| `source` | required | the [`Ui.ConversationSource`](conversation-source.md) the chat talks to |
| `header` | optional | the [nodes drawn above the transcript](#the-header), over the open conversation and the chat's commands; omitted, a bar holding the export command; `[]`, no header |
| `placeholder` | optional | a text shown in the empty message box; omitted, none is drawn |
| `starters` | optional | prompts offered on an empty conversation, each a text or `{ prompt, onChoose }`; `onChoose` is `send` (default: choosing sends the prompt) or `fill` (puts the prompt in the message box and sends nothing, so a file can be attached first). Default none |
| `show` | optional | `{ reasoning, toolDetail, usage, copy }`, each a boolean, `true` when left out |
| `buttons` | optional | how each button is drawn: `{ copy, edit, regenerate, attach, send, stop }`, each a [`Ui.TextButton` or `Ui.IconButton`](#buttons-as-icons) |
| `composer` | optional | `{ actions }`: `inside` (default) puts the attach and send (or stop) buttons inside the message box's frame, after the text; `outside` puts them in a row under the box |
| `conversation` | optional | `{ parameter }`: the page query parameter holding the id of the conversation shown, a name like a page query parameter's. Omitted, the choice lives in memory and a reload starts a new conversation |
| `refreshes` | optional | requests read again, as an action's [`onSuccess.refreshes`](action.md#after-a-success) (a `*` / `**` segment covers several paths), over `conversation.id`, the id of the conversation the send or the turn belongs to |

`placeholder` and each starter's `prompt` are [texts](texts.md) with no values,
written in the module's `lang:`.

```yaml
kind: Ui.Page
metadata: { name: assistant }
path: /
title: Assistant
children:
  - type: composite
    ref:
      kind: Ui.Chat
      source: { kind: Ui.ConversationSource, conversation: !ref assistant, basePath: /api/chat }
      placeholder: Ask anything
      starters:
        - What can you do with an image or a PDF?
        - { prompt: Summarise the attached PDF, onChoose: fill }
      show: { usage: false }
```

## What the endpoint decides

The chat reads the `Conversation.Spec` of its source once, and the node it
provides carries that spec unchanged. Availability comes from the spec alone:
no upload control without `attachments`, edit-and-resend and branches only with
`branch`, stop only with `cancel`.

Branching includes the first message of a conversation (a new root, sent with
`parent: null`); the switcher is drawn from each entry's `siblings`, and a
conversation opened while its turn runs continues live, a turn waiting on
approval showing its approval cards after a reload. The client's behaviour is
described in the [renderer's chat page](../../ui-react/docs/chat.md).

A `show` switch can only hide: `reasoning` the model's reasoning panels,
`toolDetail` the arguments and result of tool calls, `usage` the token counts
under a reply, `copy` the button copying a message (a code block's
own copy button stays). None turns on what the spec does not offer. Edit,
regenerate and the version switcher have no switch: they follow the spec's
`branch` operation.

## The header

`header` is a list of [nodes](nodes.md) drawn top to bottom above the
transcript. Two roots are in scope there, read as accessor chains:

- `conversation` — the open conversation's `Conversation.ConversationSummary`
  (`id`, `title`, `archived`, `turn`, `running`, `updatedAt`), or `null` for a
  new conversation. Once a conversation is open — opened, or its first send
  admitted — it holds nothing until its record is read, so no condition over it
  holds and a new conversation's label does not flash while one loads. It is
  read again whenever the chat reads `<basePath>/conversations/<id>`: on open,
  on a refresh announced for it, and when a turn starts or ends. A condition
  reading through `null` holds nothing, so `conversation.title` matches `null`
  only for an untitled conversation, and a new one is matched by
  `conversation` itself.
- `chat` — the chat's [commands](nodes.md#commands), each a `Ui.Command`
  `{ offered, enabled }`:

| Command | Does | Offered | Runs |
| --- | --- | --- | --- |
| `exportTranscript` | downloads the transcript as Markdown | always | once it holds a message |
| `copyTranscript` | copies the transcript as Markdown | always | once it holds a message |
| `stop` | stops the reply being written | where the endpoint offers `cancel` | while a reply is written |
| `newConversation` | opens a new conversation: clears `conversation.parameter` by a new history entry, or the selection held in memory | always | while a conversation is open or a message is drafted |

A command that is not offered is not drawn, and one that cannot run is drawn
disabled. A failed export or copy is drawn under the header
(`ERR_UI_EXPORT_FAILED`, `ERR_UI_COPY_FAILED`).

```yaml
header:
  - type: bar
    start:
      - { type: value, value: !cel "conversation.title", style: heading, shown: { at: !cel "conversation.title", matches: { type: string } } }
      - { type: text, text: Untitled conversation, style: heading, shown: { at: !cel "conversation.title", matches: { type: "null" } } }
      - { type: text, text: New conversation, style: heading, shown: { at: !cel "conversation", matches: { type: "null" } } }
    end:
      - type: command
        command: !cel "chat.exportTranscript"
        text: Export
        button: { kind: Ui.IconButton, icon: { kind: UiLucide.Icon, name: download } }
```

Omitted, the header is one `bar` whose `end` holds `exportTranscript`, drawn by
`ui`'s keyed text `chatExport`. `header: []` draws no header at all. A link and
a [`Ui.Action`](action.md) work there as anywhere: a link's address may read
`conversation.id`, and a link to the page itself with no query parameter opens a
new conversation when the chat follows the address.

## Buttons as icons

Six buttons are configurable under `buttons:`, each naming a kind of
`Ui.ButtonDisplay`:

- `Ui.TextButton` has no keys: the button is its text. Name it on `copy`, `edit` or `regenerate` to opt out of the icon.
- `Ui.IconButton` draws a glyph. `icon` is a [`Ui.Icon`](icons.md) (a
  `Ui.FileIcon`, or an icon set's kind such as `UiLucide.Icon`); omitted, the
  look draws its own glyph for what the button does. `label` is `hidden`
  (default) or `shown`: hidden, the button's text is its accessible name and a
  tooltip shown on hover and focus; shown, the glyph comes before the text.

| Key | The button's text, and its glyph without an `icon` |
| --- | --- |
| `copy` | copies a message (`chatCopy`, then `chatCopied`): `copy`, then `done` while confirmed |
| `edit` | opens a message for editing (`chatEditMessage`): `edit` |
| `regenerate` | writes a reply again (`chatRegenerate`): `regenerate` |
| `attach` | opens the file picker (`chatAttach`): `attach` |
| `send` | sends the message (`chatSend`): `send` |
| `stop` | stops the reply (`chatStop`): `stop` |

The message buttons (`copy`, `edit`, `regenerate`) are icons unless named: omitted is byte-equal to `{ kind: Ui.IconButton }`, the look's glyph with the text as accessible name and tooltip. The other three are a `Ui.TextButton` unless named. Nothing else is configurable:
approve, reject, resend, cancel, retry, continue and load earlier stay words,
and the branch arrows and the attachment's remove button stay the look's glyphs. A text
button given a `label` is refused (`SCHEMA_VIOLATION`), an `icon` that is not an
icon is `REFERENCE_KIND_MISMATCH`, and an icon file that is not an SVG, PNG or
WebP image is `ERR_UI_ICON_FORMAT_UNKNOWN` when the chat is first read.

```yaml
kind: Ui.Chat
source: { kind: Ui.ConversationSource, conversation: !ref assistant, basePath: /api/chat }
show: { copy: false }
composer: { actions: outside }
buttons:
  copy: { kind: Ui.TextButton }
  regenerate: { kind: Ui.IconButton, icon: { kind: UiLucide.Icon, name: refresh-cw } }
  send: { kind: Ui.IconButton }
```

## The node

The chat provides a `chat` node. Every member is present, `ui` having filled
each default:

| Member | |
| --- | --- |
| `spec` | the endpoint's `Conversation.Spec` |
| `basePath` | the source's `basePath` |
| `header` | the header's nodes, resolved; the default bar when not written, `[]` for none. A `command`'s `command` is a binding into `chat` |
| `placeholder` | the text record, or `null` when not written (not drawn) |
| `starters` | `{ prompt, onChoose }` each, the prompt a text record and `onChoose` always present (`send` when left out or written as a bare text); `[]` when none |
| `show` | `{ reasoning, toolDetail, usage, copy }`, all booleans |
| `buttons` | all six keys, each `{ type: text }` or `{ type: icon, icon, label }`: `icon` an `{ digest, name }` file address or `null` (the look's glyph), `label` `shown` or `hidden`. A `copy`, `edit` or `regenerate` left out is `{ type: icon, icon: null, label: hidden }`, any other `{ type: text }` |
| `composer` | `{ actions }`, `inside` or `outside` |
| `conversation` | `{ parameter }`, or `null` when the choice lives in memory |
| `refreshes` | the [address](nodes.md#addresses) wires of `refreshes`, `[]` when none; read over the root `conversation` (`{ id }`) |
| `style`, `shown`, `fill` | as every [node](nodes.md) |

An icon's file travels in the chat composite's `assets`, addressed by its
content digest. Every text the node carries is found by `SpecTranslator`, so a
renderer translates it like any other.

## The chat's own texts

What the chat draws without being told — the message box's accessible name
(`chatMessage`, always drawn and never taken from the placeholder), send, stop,
attach, approve, reject, copy, regenerate, edit, usage, how a turn ended — are keys of `ui`'s own
[`Ui.Translations`](texts.md#uis-own-texts), all beginning `chat`, translated
into every language `ui` ships. An application writes nothing to show them, and
overrides one by listing a `Ui.Translations` of its own after the shipped one.
The one keyed text `Ui.Chat` fills itself is `chatExport`, the default header's
command, so its schema names `[Self.Translations]` in `x-telo-text-keys`.

## Problems from the endpoint

How the chat shows a failed request is the client's behaviour:

- A `400` problem whose `data.issues` name what was refused is worded with
  `ui`'s validation texts, as a [form's](form.md) are.
- Any other problem is shown as an error carrying its `code` and `detail`.
- A problem without a `code` falls back to `ERR_UI_UNAUTHORIZED` (401),
  `ERR_UI_FORBIDDEN` (403) or `ERR_UI_REQUEST_FAILED`.
- A `2xx` body the contract refuses is `ERR_UI_RESPONSE_INVALID`, as for
  [actions](action-contract.md) and [records](record-contract.md).
- A dropped event stream is resumed with `Last-Event-ID`; an `error` event is
  shown in place with its code.

## A page of conversations

The chat is one half of a page; the other is a listing of conversations, a
[`Ui.Listing`](listing.md) over a [`Ui.CollectionSource`](collection-source.md)
for `Conversation.conversations`, in a [`Ui.SplitView`](split-view.md) that folds
it away on a narrow viewport. A row links to the page with the conversation in the
parameter the chat names, "New conversation" is a link to the page itself, a
delete is the listing's own `delete`, rename and archive are
[`PATCH` row actions](action.md), and the running mark is a `badge` shown over
`row.running`.

```yaml
kind: Ui.Page
metadata: { name: assistant }
path: /
title: Assistant
width: full
children:
  - type: composite
    ref:
      kind: Ui.SplitView
      label: Conversations
      size: small
      aside:
        actions:
          - { type: link, text: New conversation, href: { path: !ref assistant }, button: { kind: Ui.IconButton, label: shown } }
        content:
          type: composite
          ref:
            kind: Ui.Listing
            model: !ref Conversation.ConversationSummary
            presentation:
              kind: Ui.CollectionPresentation
              source: { kind: Ui.CollectionSource, collection: !ref Conversation.conversations, basePath: /api/chat/conversations }
            filters: { archived: false }
            paging: scroll
            delete: true
            layout:
              kind: Ui.ListLayout
              content:
                type: stack
                children:
                  - { type: value, value: !cel "row.title", href: { path: !ref assistant, queryParams: { conversation: !cel "row.id" } } }
                  - { type: badge, text: Replying, shown: { at: !cel "row.running", matches: { const: true } } }
      content:
        type: composite
        ref:
          kind: Ui.Chat
          source: { kind: Ui.ConversationSource, conversation: !ref conversation, basePath: /api/chat }
          conversation: { parameter: conversation }
          refreshes: [/api/chat/conversations]
        fill: true
```

With `fill: true` on the content the chat reaches the bottom of the viewport:
the split view and the page fill too, the message box sits at the bottom and the
transcript scrolls, while the aside scrolls on its own. `examples/chat` is this
page whole, with its header and its rename and archive row actions.

## Following the page

With `conversation: { parameter }` the chat reads that parameter of the address:

- absent or empty is a new, empty conversation;
- an id opens that conversation by the contract's reopen steps;
- the conversation the chat creates — its first admitted `POST /turns` — is
  written into the parameter by replacing the current history entry, so the
  address can be shared and reloaded and back does not step through it;
- a changed parameter (a link, back, forward) switches conversation without
  cancelling the running turn, each conversation keeping its own draft;
- a conversation that cannot be opened — `ERR_CONVERSATION_NOT_FOUND`, or any
  failure — is drawn in place with its code and detail, the message box takes
  nothing, and the parameter is kept.

The chat reads `<basePath>/conversations/<id>`, so a rename, archive or delete of
the shown conversation, announced by an action or a listing, reads it again (a
deleted one is drawn as not found). Its `refreshes` are announced when a send is
admitted and when a turn the chat started or followed ends, whatever its reason;
a listing of the collection at `refreshes`' path then shows the new conversation
and its running mark.

## Checked before the app runs

`refreshes` entries take wildcard segments as an action's
[do](action.md#after-a-success) (`/api/chat/conversations/**`), and are checked
as an action's are: an entry reading anything but
`conversation.id` is `CEL_UNKNOWN_FIELD`, and a `parameter` that is not a query
parameter name is `SCHEMA_VIOLATION`. A chat given `title`, `show.export`,
`buttons.export`, `show.sidebar`, `compact` or `buttons.newConversation`, which
it no longer takes, is `SCHEMA_VIOLATION`; the header says what `title` and the
export switch and button did. In the header, `chat` or `conversation` read
outside it is `CEL_UNKNOWN_IDENTIFIER`, an unknown command or summary field
`CEL_UNKNOWN_FIELD`, and a `command` naming something that is not a command
`CEL_TYPE_ERROR` (`ERR_UI_COMMAND_UNRESOLVED` for a fixed value, when the chat
is first read).
