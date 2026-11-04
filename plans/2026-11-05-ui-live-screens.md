---
status: draft
priority: medium
depends-on: [2026-11-05-broadcast-channels.md]
packages: [modules/data-model, modules/ui, modules/ui-react, modules/crud, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Screens that update when anyone writes

## Problem

A screen re-reads only after its own tab writes. When an action answers 2xx, the renderer announces the paths it wrote and every `Ui.Data`, `Ui.Listing` and `Ui.Chat` reading one of them reads again — but the announcement lives in that tab's memory. Another tab, another viewer, a worker or a scheduled job changing the same records leaves every other screen stale until the viewer reloads or refocuses the window (`reloadOn: [focus]`). The timed refresh in the review-app plan (`refreshEvery`) polls on an interval; it costs a read per tick whether or not anything changed, and is still late by up to one interval.

`UiReact.App` already holds a server-sent event stream open to every tab (`<mount>/_telo/ui/events`); today it carries only `hello`, used to reload the page when the renderer bundle changes and to refetch the documents after a reconnect.

## Solution

**One message type, owned by the collection contract.** `data-model` exports `DataModel.ChangeMessage`: `{ paths }`, one to 64 server-absolute request paths, each literal or with a whole `*` / `**` segment — the grammar `refreshes` already has. `data-model` imports nothing and both `ui` and `crud` already import it, so neither imports the other.

**The App relays a channel.** `UiReact.App` gains `changes`, a reference to a `Broadcast.Channel` whose `messageType` is `DataModel.ChangeMessage`; its description says a memory channel serves one instance only. Each App instance holds one subscription to the whole channel (no topic filter: a change message carries no topic, since its paths are what it is about), opened when it starts; a channel it cannot subscribe to fails the start with `ERR_BROADCAST_UNAVAILABLE`. For each open event stream it keeps the paths under its own mount, made mount-relative, and sends them as one `changed` event per 100 ms window, deduplicated. Every address the App's screens request resolves under its mount (an app-relative `/api/tasks` is requested at `/admin/api/tasks`), so a path outside the mount names nothing a screen reads and is dropped. A channel `gap`, or a window holding more than 256 distinct paths, is sent as `resync`. The stream accepts no filter from the browser.

**The browser treats a `changed` path exactly as its own write.** Paths arriving within one animation frame join the tab's announcement bus together, each as an `onSuccess.refreshes` entry does: matched against each node's resolved, encoded request path (templated `basePath`s and page path variables included), so every reader, listing (its groups, periods, tree levels and facets), relation label and chat reading a covered path reads again under the existing reload rule — loaded pages refetched in order, the first page only past ten, records matched by key, so scroll, focus, open forms and entered values stay. `resync`, and a reconnect of the event stream, re-read every data node on the page. While the document is hidden, announcements are held as a deduplicated set of at most 256 paths (past that, a `resync`) and applied once when it is shown; a node hidden by `shown` reads once when shown, as today.

**Publishing.** Anything may publish on the channel with `Broadcast.Publish` — a route's handler, a queue worker, a scheduled job; a publisher that cannot name a path exactly (a templated `basePath` it does not know) publishes a wildcard. `Crud.Api` gains `changes: { channel, records? }`: after each create, replace and delete it publishes, in one message, the collection path and — unless `records: false` — the record path, both taken from the request it answered (a create's request path and the new record's path under it; a replace's or delete's path and its parent), so it never needs to know where it is mounted. It publishes inside the write's transaction where the backend offers one, so a rolled-back write announces nothing, and a publish that fails fails the write.

**Rules**, pinned both ways in each module's tests and twinned by the controller:

- `UI_CHANGES_MESSAGE_TYPE_MISMATCH` — the App's `changes` channel whose `messageType` is not `DataModel.ChangeMessage`; `CRUD_CHANGES_MESSAGE_TYPE_MISMATCH` the same for `Crud.Api`.
- A path breaking the grammar is refused by `DataModel.ChangeMessage`'s own schema: `SCHEMA_VIOLATION` for a literal, `ERR_INPUT_INVALID` at the publish for a computed one.

**Before / after.** Before, two people looking at one task board see each other's moves only after a reload. After, the board's App names `changes: !ref uiChanges`, `Crud.Api` names the same channel, and a card one viewer moves moves on the other's screen within one read.

## Decisions

- **Paths, never data.** An event names what changed; each screen re-reads it through its own routes, under the viewer's own authentication and authorization. Sending the new records would bypass both and duplicate the read shapes into a second wire.
- **Paths are visible to anyone who can open the mount's event stream** — today anyone who can load the App, and under the identity plan whoever its mount authenticates. A path like `/api/salaries/42` reveals that record 42 changed; `records: false` publishes the collection path alone. Filtering per viewer needs the principal the identity plan delivers, and is not attempted here.
- **The channel is a trust boundary.** Whoever may publish on it can make every connected screen re-read; sharing a channel between applications grants that.
- **One subscription per App instance, coalesced per stream.** The channel carries a message once per replica; the 100 ms window and per-frame batching bound a burst of writes to a bounded number of reloads per tab, and the reload rule collapses a trigger arriving during a read into one more read.
- **A viewer's own write is announced twice** — locally and by the echo — costing at most one extra read per affected node. Rejected: tagging writes with a tab identity, which every publisher would then have to carry through its handlers.
- **A gap, an overflow or a reconnect re-reads everything.** At-most-once delivery cannot say what was missed; re-reading the page is the only correct answer and costs one read per data node.
- **No per-node switch.** A server announcement is the same fact as a local one, which already reloads unconditionally. Rejected: `reloadOn: [changes]`, which would make the same write reload a node from one tab and not from another.
- **Complements `refreshEvery`** rather than replacing it: a timer suits data no publisher announces.

Bookkeeping: docs (`data-model` new `change-message.md`; `ui` `data.md`, `listing.md`, `action.md` "After a success", new `changes.md`; `ui-react` `app.md`, `urls.md` § Events with the `changed` and `resync` events; `crud` `api.md`); the showcase gains a channel shared by its App and `Crud.Api`, with an integration test running two `App.Instance` children on one PostgreSQL database that reads one's event stream after the other writes; the hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library, "Screens that update when anyone writes"; `Added` fragments for `data-model`, `ui`, `ui-react`, `crud`. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it.

## Verify

- Two `App.Instance` children on one PostgreSQL database: a `PUT /admin/api/tasks/7` through one instance's `Crud.Api` produces a `changed` event naming `/api/tasks` and `/api/tasks/7` on an event stream opened against the other.
- A `Crud.Api` mounted at `/v2/api/tasks` beside an App at `/v2` reloads the App's listing of `/api/tasks`; one with `records: false` publishes only the collection path.
- In the browser, a board open in two tabs: moving a card in one moves it in the other with one listing reload, and the second tab's open edit form keeps its entered values.
- A write rolled back inside its transaction produces no `changed` event.
- 1,000 writes in one second produce at most ten `changed` events per stream and at most one queued reload per node; 300 distinct paths in one window produce a `resync`.
- Restarting the database sends `resync` and every data node re-reads once; a hidden tab makes no request until shown, then one per node.
- A channel of another message type on `changes` is `UI_CHANGES_MESSAGE_TYPE_MISMATCH`, refused at the declaring library and failing a consumer's run with the twin.

## Example after the change

```yaml
kind: BroadcastPostgres.Channel
metadata: { name: uiChanges }
name: ui_changes
connection: !ref db
maxBytes: 2048
messageType: !ref DataModel.ChangeMessage
---
kind: UiReact.App
metadata: { name: board }
title: Board
theme: !ref UiReact.defaultTheme
changes: !ref uiChanges
pages: [!ref boardPage]
---
kind: Crud.Api
metadata: { name: tasksApi }
connection: !ref db
singular: task
plural: tasks
collection: !ref tasks
changes: { channel: !ref uiChanges }
```
