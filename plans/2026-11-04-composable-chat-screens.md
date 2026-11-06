---
status: done
priority: high
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/conversation, modules/ai-chat, analyzer/nodejs, kernel/nodejs, apps/authoring-agent, apps/hub]
---

# Composable chat screens

Lands on the unpublished chat work (Phases 1–4 of the chat plan), before it is released.

## Problem

`Ui.Chat` draws its own conversation sidebar: list, search, an archived switch, rename, archive, delete and "new conversation", each behind a switch of its own (`show.sidebar`, `compact.sidebar`, `buttons.newConversation`) and gated by `Conversation.Spec.operations`. Every new wish — tabs instead of the archived switch, a board of conversations, a column with the model used — becomes another switch on one kind. Everything the sidebar does already exists in `ui` as a general kind (`Ui.Listing`, `Ui.Filters`, `Ui.RowAction`, `tabs`), but a page cannot compose them into a chat, because:

- nothing places a listing beside other content and folds it into a drawer on a narrow screen (`columns` only wraps; `Ui.Panel` is a listing's form surface; `Ui.AsidePlacement` folds only a filter bar);
- a row cannot link to `?conversation=<row.id>` — accessors are plain chains and a summary carries no address;
- `Ui.Action` always POSTs JSON to a fixed `source.path`, so `PATCH /conversations/{id}` and `DELETE /conversations/{id}` cannot be targets;
- `Ui.Chat` cannot read which conversation the page selects, nor tell a listing that a turn changed it.

## Solution

**One address form.** `Ui.Address` (links, navigation) and `Ui.RequestTarget` (requests) are one grammar: a literal string, or `{ path, pathParams, queryParams }`. `path` is a literal template whose `{name}` placeholders are whole segments, a plain chain reading a complete address from data (never expanded), or — for `Ui.Address` only — a `!ref` to a `Ui.Page`, resolved to its `path` at creation. Each `pathParams` / `queryParams` value is an accessor or a literal; their roots are whatever the use site binds (`row`, `query`, `data`, `input`, `result`). It is accepted by `link.href`, menu items, a new `value.href`, new `list` and `Ui.TableLayout` column `href`s, relation `href`s, `onSuccess.navigate`, `Ui.Action.request.target`, `onSuccess.refreshes`, `Ui.Data.source` (its `params` renamed `queryParams`) and `Ui.Chat.refreshes`. A link's `href` stops being evaluated per request on the server; a per-request choice is two `link` nodes with `when`. The renderer expands one way, pinned by `modules/ui/conformance/addresses.json` that both `ui` and `ui-react` test against: segments percent-encoded with only unreserved characters left (`a/b` → `a%2Fb`, `..` → `%2E%2E`), an empty or absent segment value unresolved; query parameters in declaration order, null and empty lists left out, a list repeating its key; the result held to the address rule and resolved under the mount. An address that does not resolve is `ERR_UI_ADDRESS_UNRESOLVED` (`data.parameter`): a link is drawn as text, a request is not sent and its `failure` is drawn, a refresh is skipped. A move to the page already shown keeps its nodes mounted; each reader re-reads the parameters it declares.

The template is checked by a new generic annotation `x-telo-path-params-for: { template, through? }` on a `pathParams` map — `template` names the sibling holding it, `through` the field of a referenced declaration holding it (`ui` writes `through: path` for a page reference). Codes: `PATH_TEMPLATE_INVALID`, `PATH_PARAMETER_UNBOUND`, `PATH_PARAMETER_UNUSED`, `PATH_PARAMS_FOR_INVALID`, each raised by the kernel as `ERR_<code>` from the same reader.

**Actions with a method.** `Ui.Action.source` is replaced by `request: { method, target }`, `method` one of `POST` (default), `PUT`, `PATCH`, `DELETE`, `target` a `Ui.RequestTarget` over `input`. An input property is consumed when a binding is exactly `input.<property>`; for `POST` / `PUT` / `PATCH` the JSON body is the input's properties that hold a value minus the consumed ones; a `DELETE` sends no body and must consume every input property (`UI_ACTION_INPUT_UNSENT`, a rule on `Ui.Action` twinned by `ERR_UI_ACTION_INPUT_UNSENT`). A 2xx with no body is a success unless something reads `result` (then `ERR_UI_RESPONSE_INVALID`). `Ui.RowAction` is unchanged: its `inputs` fill `input`, which fills the target. After a 2xx the renderer notifies the resolved target path, each `refreshes` path and, in a listing, its `basePath`; a `Ui.Data`, `Ui.Listing` or `Ui.Chat` reading exactly a notified path (resolved, encoded, query excluded) reads again. `action-contract.md` becomes `<method> <target>` with these body rules.

**A fold-out side panel.** `Ui.SplitView` (a composite; wire node `split`) draws an `aside` tree beside a `content` tree: `side` (`start` | `end`), `size` (`small` | `medium` | `large`, as `Ui.Panel`), a required `label` (the aside's landmark name and its toggle's text), optional `collapse: { collapsed, state: { key, store } }` (kept under `telo.ui:<mount>:s:<key>`), and `compact`, a `Ui.ViewportOverlay` defaulting to `{ kind: Ui.Drawer, side: <side> }`, used below `compactBelow`. The aside stays mounted in every state and starts no request while not visible; a move within the app started from the compact surface closes it. Parts `split`, `split-aside`, `split-content`, `split-toggle`; keyed texts `splitShow` / `splitHide`, translated in all fourteen catalogs.

**The chat follows the page.** `Ui.Chat` gains `conversation: { parameter }`, naming the page query parameter it reads and writes: absent or empty is a new conversation; a present id is opened by the contract's reopen steps; a conversation the chat creates is written back by replacing the current history entry; a changed parameter (a link, back, forward) switches conversation without cancelling the running turn, drafts staying with their conversation. A missing conversation is drawn in place as its error and the parameter is kept. Omitted, the selection lives in memory. `refreshes: [Ui.RequestTarget]` over a `conversation: { id }` root fires when a send is admitted and when a turn the chat followed ends. The chat reads `<basePath>/conversations/<id>`, so a rename or delete of the shown conversation reaches it through invalidation.

**What leaves the chat.** `Ui.Chat` drops `show.sidebar`, `compact` and `buttons.newConversation`, and the sidebar with its parts, styles and keyed texts. `Conversation.Spec.operations` keeps only `branch` and `cancel`. `conversation` exports `Conversation.conversations`, a `DataModel.Collection` over `ConversationSummary` (key `id`, filters `title contains` and `archived eq`, sort `updatedAt`), and `ai-chat`'s `GET /conversations` speaks the collection contract against it (`limit` 1–100, default 25, `-updatedAt` by default; `q=` retired); its read, `PATCH` and `DELETE` routes stay, served regardless of the spec. A page composes the list as a `Ui.Listing` over a `Ui.CollectionSource` for that collection: rows link with `queryParams: { conversation: row.id }`, delete is the listing's own `delete`, rename and archive are `PATCH` row actions, the running mark is a `badge` shown over `row.running`, "New conversation" is a `link` to the page.

**Before / after.** Before: a chat page is `Ui.Chat` plus switches; anything else is a feature request. After: the same page is a `Ui.SplitView` holding a listing and a chat (example below), and tabs, a board or extra columns are ordinary `ui`.

## Decisions

- **Two shapes, one grammar.** Links may leave the origin or name a page; requests may not. One expansion and one wire form (`{ path, pathParams, queryParams }`, every member present) keep them one thing. Rejected: one map with leftovers going to the query (a misspelt key silently becomes a parameter).
- **An annotation checks templates, not a resource rule.** A rule cannot reach an address inside a node tree. This replaces the review-app-screens plan's `UI_PATH_PARAMETER_UNBOUND` / `_UNUSED` and `ERR_UI_PATH_PARAMETER_MISSING`; that plan is edited in the same change to keep only page path variables, the `path` root, `UI_PATH_PARAMETER_UNPROVIDED`, templated `basePath` with `UI_SOURCE_PARAMETER_UNPROVIDED`, and the rest of its scope, and gains this plan in `depends-on`.
- **A page reference as `path`.** Renaming a page's `path` moves every link to it; checked through `through: path`.
- **"Consumed" is an exact `input.<property>` chain.** A closed body schema (`ConversationPatch`) refuses the key the path carries; a DELETE has nowhere else to put an input, so an unconsumed one is refused rather than moved to the query implicitly.
- **A write invalidates its own target.** A rename otherwise never refreshes a reader at the path it wrote.
- **`conversation: { parameter }`, not an accessor.** An accessor only reads, and a created conversation must be written back so it can be linked and reloaded.
- **A 404 conversation keeps its parameter.** Clearing it would hide the failure from whoever followed the link.
- **`Ui.SplitView` is a composite, not a node or a `columns` variant.** Its surface and store references need static refusals (`UI_SURFACE_COMPACT_ADDRESSED` / `_NESTED`, reused), which rules reach on a composite only; a `columns` variant would change its sibling keys. No rail state: arbitrary content has no glyph per entry.
- **The collection declaration lives in `conversation`.** The contract owns it, and `data-model` imports nothing, so `ui` and `ai-chat` still never import each other or `ai`.
- **Delete is the listing's `delete`, not a row action; the running mark is a badge.** A second spelling of one operation, and a colour-only signal, are both refused.

Bookkeeping: `ui` keeps its `requires: telo:` floor — the previous published CLI reads and runs it, ignoring the new annotation, so a higher floor would check nothing; no manifest migration — `Ui.Data` `source.params` and `Ui.Action` `source` become `SCHEMA_VIOLATION` (a migration would have to match the literal `Ui.` prefix and list every hosting kind), every in-repo manifest is updated by hand, and the `ui` fragment describes the break; `tests/check-run-agreement.yaml` gains rows for the annotation's codes; the annotation is documented in the root and analyzer `CLAUDE.md` and a `docs/extend/` guide; docs (`nodes.md`, `action.md`, `action-contract.md`, `data.md`, `listing.md`, `collection-presentation.md`, `page.md`, new `split-view.md`, `surfaces.md`, `chat.md`, `conversation-contract.md`, `ai-chat` `api.md`, `ui-react` chat and `urls.md`), the primer, the hub `build-ui` guide, the benefits ledger entry for the chat page (no longer "a conversation sidebar"; plus addresses and methods on actions), the chat plan's Phase 6 (studio gates on `branch` / `cancel` only), and one `Added` fragment per module describing the break.

## Verify

- A listing row with `queryParams: { conversation: row.id }` renders `/?conversation=cnv_…` and moves within the app; sending in an empty chat at `/` changes the address to `/?conversation=cnv_…` with no new history entry; the row then shows its running badge until `turn-end`.
- `pathParams: { idd: … }` against `/x/{id}` is `PATH_PARAMETER_UNBOUND` and `PATH_PARAMETER_UNUSED` under `telo check` and fails the run with the `ERR_` twins; `row.nmae` in one is `CEL_UNKNOWN_FIELD`; renaming a referenced page's `path` changes every link to it with no other edit; the address vectors pass in both halves.
- A rename row action sends `PATCH /api/chat/conversations/cnv_x` with body `{"title":"…"}` and both the listing and the open chat read again; a `DELETE` action with an unconsumed `note` is `UI_ACTION_INPUT_UNSENT` statically and at run; a 204 with no `outputModel` draws success.
- `/?conversation=cnv_missing` draws `ERR_CONVERSATION_NOT_FOUND` in place and keeps the address; deleting the shown conversation from the list draws the same.
- A collapsed aside holding a listing makes no request until shown; crossing the breakpoint keeps the listing's page; a stored `collapsed: true` beats `collapse.collapsed: false`; an `address` on `compact` is refused both ways.
- `Ui.Chat` with `show: { sidebar: false }` is `SCHEMA_VIOLATION`; `/capabilities` lists exactly `[branch, cancel]`; `GET /api/chat/conversations?title.contains=x&sort=-updatedAt&limit=2` pages as the collection contract says (`Assert.Equals`); `CheckTheme` passes for both themes and the showcase brand theme.

## Example after the change

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
      collapse: { state: { key: conversations, store: { kind: Ui.LocalStore } } }
      aside:
        type: stack
        children:
          - { type: link, text: New conversation, href: { path: !ref assistant } }
          - type: composite
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
              rowActions:
                - prompt: true
                  inputs: { id: !cel "row.id" }
                  action:
                    kind: Ui.Action
                    label: Rename
                    inputModel:
                      kind: Telo.JsonSchema
                      schema: { type: object, required: [id], properties: { id: { type: string }, title: { type: string, title: Title, minLength: 1 } } }
                    request:
                      method: PATCH
                      target: { path: /api/chat/conversations/{id}, pathParams: { id: !cel "input.id" } }
      content:
        type: composite
        ref:
          kind: Ui.Chat
          source: { kind: Ui.ConversationSource, conversation: !ref conversation, basePath: /api/chat }
          conversation: { parameter: conversation }
          refreshes: [/api/chat/conversations]
```
