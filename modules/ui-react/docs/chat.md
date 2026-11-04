# The `chat` node

The renderer's client of the [conversation contract](../../conversation/docs/conversation-contract.md):
the node [`Ui.Chat`](../../ui/docs/chat.md) provides. It draws a conversation
— its transcript, a message box and, only where the endpoint offers it, an
upload control — and speaks the contract's
routes under the node's `basePath` through `host.fetch`, so every request
carries the page's credentials and is made relative to the mount.

## What the spec decides

The node carries the endpoint's `Conversation.Spec` and the renderer reads
nothing else about the endpoint — never `GET /capabilities`.

| The spec | The chat |
| --- | --- |
| `attachments` absent | no attach button, no drop target, no paste handling, under any `show` |
| `attachments` | the attach button, drag-and-drop and paste; each file checked against `accepts` and `maxPerMessage` before it is uploaded |
| `branch` | edit-and-resend, regenerate, and the version switcher |
| `cancel` | the stop button, and the header's `stop` command |

A `show` switch can only hide: `reasoning`, `toolDetail` (a tool call's
arguments and result), `usage` and `copy` (a message's copy button; a code
block's stays). None turns on what the
spec does not offer.

## The header

The node's `header` nodes are drawn top to bottom in `chat-header`, which is not
drawn when there are none. Two roots are bound there: `conversation`, the
summary `<basePath>/conversations/<id>` answers — `null` for a new conversation,
nothing while an open one's summary is not read yet —
read when the conversation is opened, when a write announced for that path
reads it again, and when a turn the chat started or followed starts (its send
admitted) and ends; and `chat`, the four commands a `command` node runs:

| Command | Runs | Offered | Enabled |
| --- | --- | --- | --- |
| `chat.exportTranscript` | downloads the transcript as `conversation.md` | always | once the transcript holds a message |
| `chat.copyTranscript` | writes the transcript's Markdown to the clipboard, announcing `chatCopied` | always | once the transcript holds a message |
| `chat.stop` | cancels the reply being written | where the spec offers `cancel` | while a reply is written |
| `chat.newConversation` | removes the conversation parameter from the address with `host.navigate` (a new history entry), or shows a new conversation where the choice lives in memory; with none open, discards the draft | always | while a conversation is open or a message is drafted |

A command that is not offered is not drawn; one that cannot run is a disabled
`command` part. Its `data-command` names it and, for a `Ui.IconButton` given no
icon, chooses the look's glyph: `export`, `copy`, `stop` and `add`. A failed
export or copy is drawn as an error node under the header,
`ERR_UI_EXPORT_FAILED` or `ERR_UI_COPY_FAILED`. A `command` node naming no
command of a root in scope is drawn as `ERR_UI_COMMAND_UNRESOLVED`.

## Filling

A filling chat (`fill: true` on the node, see [filling](styling.md#filling)) is
as tall as the room it is given, no shorter than `24rem`; the transcript scrolls
inside it and the message box stays at its bottom. A chat that does not fill is
`min(48rem, 100vh - 8rem)` tall.

## Buttons

The node's `buttons` says how each of six buttons is drawn. A text button is
its text. An icon button is a glyph: the look's own through the `Icon` control
(an `icon` part), or the page's file as a `glyph` part, served by its digest
under `_telo/ui/assets/` and painted over the text's colour. With `label:
hidden` the text is the button's `aria-label` and the `Tooltip` control shows it
on hover and focus; with `shown` the glyph comes before the text. The copy
button's text becomes `chatCopied` for two seconds after a successful copy: a
glyph display draws the `done` glyph in place of `copy` meanwhile, and the
chat's polite live region announces the text once. A failed copy draws the
error beside the button instead.

## The transcript

Messages are drawn in order, each block through the part that fits it:

- **Text** through the [`markdown` renderer](markdown.md). Raw HTML is text, a
  link follows the address rule, and an image is drawn only from an
  app-relative address — an attachment under `basePath` is one; an image at any
  other origin is drawn as its alt text, because the text is a model's.
- **Reasoning** in a collapsible panel, open while it streams.
- **Tool calls** as cards with the tool's name and, when `toolDetail` holds, a
  details button showing the arguments and the result.
- **Approvals** as cards with a reason box, Approve and Reject. A turn that
  ended with `approval` is resumed when every pending request has a decision:
  one `POST /turns` carrying `approvals` with an empty `message` and no
  attachments, its events continuing the same reply.
- **Media** — images, audio, video and files — from attachment URLs, each drawn
  only from an app-relative address and otherwise as its name. An endpoint names
  an attachment by the reference `conversations/<id>/attachments/<attachment id>`,
  relative to its own base; a URL with no scheme that does not start with `/` is
  resolved under `basePath` (`/api/chat/conversations/<id>/attachments/<attachment id>`),
  here and in the Markdown export, and any other URL is used as written. A picture is a fixed-size square crop (`loading="lazy"`,
  alt = its file name), so a message's height is known before it loads; pressing
  it, or Enter or Space on it, opens the [viewer](#the-picture-viewer).
- **Citations** gathered under the message as sources; **refusals** as a note.
- **Usage** under a reply, and how a reply ended when it did not simply stop
  (cut off at the length limit, stopped by a content filter, step limit, waiting
  for approval, stopped, failed). After a step limit, Continue sends a message
  asking the assistant to go on.

The transcript is a `feed` of message articles, so a message drawn as the
transcript scrolls is never announced as new; a status region announces that a
reply began and that it is complete, and the feed is `aria-busy` while a reply is
written or earlier messages load. Each message carries its place in the conversation
as `aria-posinset` of `aria-setsize`, the total being `-1` while earlier
messages are still to be read. Each message is focusable (`tabindex="-1"`), and
Page Down and Page Up move the focus to the next and previous message drawn; a field
inside a message keeps its own keys. The rows that are not messages — the empty
note and the row standing for earlier messages — are `presentation`; the status and
alert rows (reconnecting, a failed turn, the error) stay in the feed so that they are announced.

## Scrolling

A conversation opens at its end and stays there while what is drawn settles —
images loading, code being highlighted, the chat's own height changing as the
page lays out — and while a reply is written, until the viewer scrolls up;
scrolling back to the end, or sending a message, holds it there again. Each
correction is made before the browser paints, so the transcript never shows a
frame away from its end.

Only the messages near the viewport are drawn, so a conversation of a thousand
messages costs what a screenful does. A message out of view stands in at the
height it had when it was last drawn (an estimate until it has been drawn), and
is measured again whenever its size changes — a reply streaming, an image
arriving, the edit form opening. A message holding the keyboard focus, and one
being edited, stay drawn wherever they are scrolled, so the focus is never lost
and an edit keeps its text and its files; an open reasoning or tool panel and a
typed rejection reason are kept by the chat and are as they were when their
message is drawn again. Without a layout to measure against — a hidden chat, a
simulated document — every loaded message is drawn.

Earlier pages are read as they are needed: until the transcript fills its
viewport, and whenever the viewer scrolls within one viewport of the top. While
one is read a `loading` notice stands above the first message, and once it
arrives the messages in view stay exactly where they were. A page that failed
to be read is shown as an error with Try again, and is not asked for again until
it is retried.

Because messages out of view are not drawn, the browser's find in page finds
text only in the messages drawn; the export and the copy of the transcript hold
every loaded message.

## The message box

A multiline box whose accessible name is the `chatMessage` text, always — the
node's `placeholder` is drawn over the empty box and described to assistive
technology, never used as its name. Enter sends and Shift+Enter breaks the line
(Enter while an input method is composing does neither). While a reply is
written, stop takes the place of send where the spec offers `cancel`; stop asks
the endpoint to cancel and the reply ends when the stream says so. On an empty
conversation the `starters` are offered as buttons. A starter whose `onChoose` is `send` sends
its prompt; one that is `fill` puts it in the message box, replacing any draft,
focuses the box with the caret at the end and sends nothing.

The node's `composer.actions` places the attach and send (or stop) buttons. With
`inside` — the default — they are the last child of `chat-input`, after the text
area and in flow, and `chat-input` is the frame around both; the hint stays
under it. With `outside` they are a row of the `chat-composer` after the hint.
`chat-composer` carries `data-actions` with the value. Enter sends from the text
area only: on a button inside the frame it presses that button.

**Attachments** are chosen with the attach button, dropped on the message box or
pasted. A file the endpoint does not accept — wrong type, over its size, over
`maxPerMessage` — is refused before any upload with the matching text naming
it. An accepted file is uploaded at once with `POST /attachments`, one
`multipart/form-data` file part named `file`, with its progress shown and a
remove button; send waits for uploads in progress, and a file that failed stays
listed, with its reason, until it is removed and is not sent. A picture shows a
thumbnail in its item as soon as it is chosen, from the file itself (an object URL
released when the item goes), and the message just sent shows the same thumbnails
while its reply is written, with the server's address once the entry is read back:
an upload has no address of its own until a message sends it, so a file not yet
sent is drawn only from the file itself. A message being edited keeps its files
with the addresses its entry gives them. An upload is the
one request not made with `fetch`, which cannot report the progress of a
request: it is an `XMLHttpRequest` to the same address.

## Versions of a message

With `branch`, a message you wrote can be edited and sent again, and a reply
regenerated: both send the message with the `parent` of the message they
replace, so the transcript keeps both versions as branches. A conversation is a
forest, so the first message of a conversation can be edited too: the new
version is sent with `parent: null` and becomes a sibling root.

Where the spec offers `attachments`, the edit form shows the message's files as
the same removable items as the message box, and takes more by the attach
button, by dropping on the form or by pasting into its text box, under the same
limits (the files kept count towards `maxPerMessage`) and with the same
refusals. "Save and resend" sends the files shown and their names; it waits
while an upload is under way or a file failed (remove it), and needs text or a
file. Cancelling abandons the edit's uploads. Without `attachments` the form has
no files and a regenerated or resent message keeps the ones it had.

Every entry carries its place among its siblings, and a switcher on it (position
of total, previous and next) is drawn from that alone, so it is the same after a
reload as when the versions were written. Stepping to a sibling reads the
transcript `?through=` that sibling and joins it to the entries already drawn.

## Opening a conversation

Opening one reads its summary and its latest branch, newest entries first, and
draws them from the root down; the pages above are read as the transcript
needs them (see [scrolling](#scrolling)). When the summary says its
turn is still `running`, that turn's entries are set aside and its events are
read from the start as the live turn — so its text is drawn once and continues as
it arrives — and the branch is read again when the turn ends. A tool result the
resumed turn delivers for a call a stored entry already holds is added to that
entry. When a turn's events are gone (`ERR_CONVERSATION_TURN_NOT_FOUND`), the
branch is read again instead.

A turn that ended waiting for approval shows after a reload as approval cards on
the entry holding the calls; once every pending request has a decision, one
`POST /turns` carries the `approvals` with `parent` that entry.

## Parallel conversations

A turn runs on the server whichever conversation is shown, so several conversations
run at once. Switching to another closes the event stream of the one left and
nothing else: its turn keeps running, the page keeps reading its events without
drawing them until it ends (so its `refreshes` are announced), and opening that
conversation again tails it from the start. A write to the shown conversation's
own address reads it again in place, the transcript staying drawn until the new
data arrives. What was in flight for the conversation left — a message
being started, a branch being read after a turn ended, an earlier page, a frame
already received — is dropped when it arrives and never touches the conversation
shown, nor shows a failure in it. A message being started when the viewer
switches away is still admitted by the server, its `refreshes` announced, and the
address left as the viewer set it.

Each conversation keeps its own draft — the text and the attached files — for as
long as the page is open: switching away and back restores it, a new
conversation that has no id yet has a draft of its own, and the draft moves to
the conversation's id when its first message is sent. An upload continues after
the viewer switches away and lands in the draft of the conversation it was
chosen in.

## Following the page

A node whose `conversation` names a parameter shows the conversation its
address holds in that parameter (`host.location`'s query):

- absent or empty is a new conversation; a present id is opened as above;
- the first admitted `POST /turns` of a new conversation writes its id into the
  parameter with `host.navigate(…, { replace: true })`, so the history entry is
  replaced and the chat, finding the address already names what it shows, does
  not open it again;
- a changed parameter — a link, back, forward — opens the conversation it names,
  or an empty one; the turn of the conversation left runs on, as under
  [parallel conversations](#parallel-conversations);
- a conversation that cannot be opened (`ERR_CONVERSATION_NOT_FOUND`, or any
  failure) is drawn in place as an error node with its code and detail and Try
  again, the message box takes nothing, and the parameter is left as it is.

Without `conversation` the choice lives in memory, and a reload starts a new
conversation. The list of past conversations is not the chat's: a page draws
it as a listing beside the chat, and the transcript is exported or copied as
Markdown by the header's commands.

The node's `refreshes` are resolved over the root `conversation` (`{ id }`) and
announced with `host.notifyChanged`, as an action's are: when a send is admitted
(a `2xx` of `POST /turns`, in a new or an existing conversation) and when a turn
the page started or followed ends, whatever its reason. A listing of the
conversations, or a reader of one, at a refreshed path reads again.

## When something goes wrong

- A refused request (`data.issues`) is worded with the same validation texts a
  form's findings are; any other problem is shown as an error node with its
  `code` and `detail`, and a problem without a `code` falls back to
  `ERR_UI_UNAUTHORIZED`, `ERR_UI_FORBIDDEN` or `ERR_UI_REQUEST_FAILED`. A
  `2xx` body the contract refuses is `ERR_UI_RESPONSE_INVALID`. A failed send
  offers Try again, which repeats the send under the same `idempotency-key`, so
  the endpoint starts one turn.
- An `error` event is shown in place with its code.
- A dropped event stream is reopened with `Last-Event-ID` set to the last
  frame's `id`, after a growing pause, and again while frames keep arriving; if
  it cannot be reopened the viewer is told and offered Try again. An event of a
  type this renderer does not know is ignored.

## Styling

Every drawn element is a `chat-…` [part](styling.md#chat), styled by both
built-in themes from the existing design tokens alone.

## Invalidation

The chat reads its open conversation at `<basePath>/conversations/<id>`. A write
announced for exactly that path (a rename or a delete from an action or a
listing elsewhere on the page, see [invalidation](urls.md#invalidation)) reads
the conversation again while no turn is running in it; a conversation that is
gone is drawn in place as its error.

## The picture viewer

Pressing a thumbnail in the transcript opens a full-screen viewer over every
picture of the conversation loaded so far — the stored entries and the turn being
written, in transcript order — at the one pressed; pressing one in the message
box or the edit form views the pictures attached there. It is the renderer's own
`MediaViewer`, drawn with the `Dialog` control (modal, the focus kept inside it
and returned to the thumbnail when it closes), so other screens can use it.

- Previous and next buttons (wrapping), the arrow keys and a swipe step through the
  pictures, with `1 of 3` shown; a single picture has none of these.
- Zoom out, reset and zoom in buttons, `-`, `0` and `+`, the wheel and a pinch
  (about the pointer), and a double click that toggles the zoom. A zoomed picture is
  dragged to pan, held within its bounds; the zoom starts fitted on every picture.
- A link to the original, Escape or the close button to leave.

Its texts are `ui`'s `mediaViewer`, `mediaPrevious`, `mediaNext`, `mediaPosition`,
`mediaZoomIn`, `mediaZoomOut`, `mediaZoomReset` and `mediaDownload`; each picture is
named by its file name.
