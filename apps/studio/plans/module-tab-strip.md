# The module tab strip: Graph · Outline · Run · Source

Supersedes the tab set described in [run-adapters.md](./run-adapters.md); the
Run half is [run-in-the-module-pane.md](./run-in-the-module-pane.md).

## Before

Seven tabs, four of which were lists: Imports, Definitions, Resources, Kinds.
They went unused, and the reasons differ per tab.

**Resources and Definitions are one list split by a taxonomy the reader does not
hold in mind** — a definition is a resource whose kind happens to be
`Telo.Definition` — so looking a name up meant knowing which tab it lived in
first. Worse, both are *navigation*, and a tab makes navigation modal: you open
the list to find something, then leave it to work, so it is never on screen when
it would help.

**Kinds** is a reference table. The question it answers — what can go here — is
answered at the point of need by the create-resource picker and the reference
picker, each filtered to the slot. Nobody starts from a table of every kind in
the closure.

**Imports** was the one with real actions, but the graph's declarations rail had
already grown add, remove, one-click upgrade and open-the-imported-module,
driving the same operations and the same compatibility check. What the tab still
held alone was the explanatory half.

## After

Four tabs: **Graph · Outline · Run · Source**.

**Outline** is one list of everything the module declares — imports first, then
resources, definitions and kinds — with a filter across all four blocks. Each
block names what a row IS and where it resolves; a kind's rendering hint
(`topology`) is not among the columns, because it steers the canvas rather than
telling the reader anything about the declaration. It lists and
navigates; selecting a row opens it in the detail panel. A block whose rows the
filter excluded is hidden rather than reported empty, since an empty block under
a filter is a claim about the filter.

Definitions are in it for a load-bearing reason: they are **not nodes on the
graph canvas**, and for a Library they are its entire content, so without this
block they would be reachable only through the raw source.

**The rail owns every import action.** It gains what the tab held alone:

- a per-import **version picker** listing every published version, each marked
  `current`, `needs newer telo` or `unreadable`, fetched when the menu opens.
  Unhostable versions are listed rather than hidden — a deliberate pick is a
  different act from the one-click upgrade, and an author may knowingly pin for
  a telo they are about to have;
- **Upgrade all** as a block-level action on the Imports section, since no row
  can offer what acts on every row;
- the **held-back** reasons: on the upgrade action's tooltip when something
  newer cannot be offered, on the version picker's tooltip when there is nothing
  to offer at all, and as one banner over the block when several imports are
  behind with nothing hostable — the remedy there is the same for all of them.

The read-out stays in the Outline: source as written, import type, resolved path
(clickable), diagnostics, and an `Outdated` badge whose tooltip names the newest
version and what is holding it back.

## Decisions

**Actions where you work, lists where you look.** The rail is visible beside the
canvas at every zoom and in every view; a tab is not. So anything that *changes*
a declaration belongs to the rail, and anything that merely *finds* one belongs
to the Outline.

**One notice vocabulary.** The blocked-imports sentence, the outdated tooltip,
the upgrade tooltip and the version-picker tooltip are shared functions, so the
rail and the Outline cannot describe the same version skew two ways.

**Persisted view hints are mapped, not dropped.** `imports`, `definitions`,
`resources` and `kinds` all resolve to `outline`, as `deployment` resolves to
`run`.

## Verify

- The strip shows four tabs, and three for a Library (no Run).
- Reopening the editor with any of the four old view names persisted lands on
  Outline rather than on the graph.
- The Outline filter narrows every block at once and hides the ones with no
  match.
- A Library's kinds are listed under Definitions and open in the detail panel.
- An import with a newer published version offers the one-click upgrade on the
  rail and a version list beside it; one whose newer version this telo cannot
  host offers no upgrade, and the reason appears on the picker's tooltip and in
  the block's banner.
- Upgrading from the rail reports a failure or a dropped pin in the same place.
