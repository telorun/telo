---
status: draft
priority: low
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/ui-react-conformance, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# A grid whose cells say how wide they are

## Problem

A page lays out content with `box`, `stack` and `columns`. `columns` puts its children side by side at equal widths and wraps them; there is no width, gap or alignment key, by design. So a dashboard cannot say "the chart is two thirds, the totals a third", nor "three summary tiles, then a full-width table", without a custom component. On a narrow screen `columns` wraps by content size, so where a child lands depends on its text.

Home Assistant's sections view is a grid in which each card declares its size in grid units and the grid reflows on narrow screens. That is also the shape a visual editor needs: resizing a card changes one number, reordering changes the list order.

## Solution

**A `grid` node.** `{ type: grid, cells }`, `cells` at least one, each cell a closed object `{ content, columns?, compactColumns? }`:

- The grid is twelve tracks wide at every width. `columns` (an integer 1–12, default 12) is how many tracks a cell spans; cells fill rows in list order and wrap to a new row when the next does not fit, so a row whose spans do not reach twelve leaves its remainder empty and never pulls a later cell back.
- `compactColumns` (an integer 1–12, default 12) is the span below `compactBelow`, the only other state: by default every cell stacks on a narrow screen, and an author keeps two tiles side by side with `compactColumns: 6`. The two spans are independent — a cell may be wider when compact.
- A row is as tall as its tallest cell and every cell in it stretches to that height; the cell's content does not stretch, so a tile's own frame (a card, a box with a style) is what a theme makes fill the cell.
- `content` is any node, a composite or another grid included. `style`, `when` and `shown` apply to the grid as to every node. A cell is not a node: a conditional cell is a cell whose `content` carries `when` or `shown`. A cell whose content is not delivered (`when` false, or a composite delivering nothing) is not emitted at all; one whose content is hidden by `shown` is not laid out while hidden. Either way it takes no track, and the cells after it move up.
- There is no placement, order or position key: the order cells are written in is the order they are drawn, read and reached by keyboard. The grid is layout and carries no ARIA role — it is not a data grid, and `role="grid"` would promise keyboard navigation it does not have.
- The gap between cells is the `space.*` scale, applied by the renderer: no gap key, consistent with "spacing is not a field".

The contract a renderer implements is those rules — twelve tracks, two spans, wrap in list order, the gap from the space scale — not CSS; `ui-react` realises them with CSS grid.

On the wire: a `grid` `Ui.SpecNode` branch whose cells carry both spans always, the defaults filled by `ui`'s node resolution so no renderer re-implements them. Parts `grid` and `grid-cell` (carrying `data-columns` and `data-compact-columns`). Reserved properties, set by `ui-react`'s base layer: `display`, `grid-template-columns`, `gap`, `row-gap` and `column-gap` on `grid`; `grid-column` and `align-self` on `grid-cell` — so a theme styles a grid's look and never its geometry.

**Before / after.** Before, a dashboard row of a two-thirds chart and a one-third summary is a custom component. After, it is a `grid` with cells of `columns: 8` and `columns: 4`, stacking on a phone.

## Decisions

- **Twelve tracks, spans as integers.** The convention every grid system uses, divisible by 2, 3, 4 and 6, and one number a visual editor changes by dragging. Rejected: named sizes (`small` / `medium` / `large`), which cannot express two thirds plus one third.
- **No row spans.** A cell's height is its content's, which is data-driven; a span of fixed-height rows would clip a listing or a reader's answer. Home Assistant can fix row heights because its cards are sized for it; Telo's content is not.
- **One breakpoint, `compactBelow`, against the viewport**, like every other compact slot in the renderer. Rejected: a third (tablet) tier, which no other compact slot has and which would make the grid change at a width nothing else does; and container queries, which would make the grid the one part of a page that changes at a different width from its surfaces, navigation and listings. A grid inside a narrow aside is given `columns: 12` by its author.
- **A separate node, `columns` unchanged.** Equal columns that wrap by content remain the right tool for a row of like items; changing `columns`' meaning would change every existing page.
- **No explicit placement.** Positions and reordering keys would let visual order differ from reading and keyboard order; list order is both, and reordering in a visual editor reorders the list.
- **Cells are not nodes.** A span is a property of a place in a grid, not of what is placed; putting `columns` on every node would give every node a key that means nothing outside a grid.

Bookkeeping: docs (`nodes.md`, `ui-react` `styling.md`); the part list and its reserved properties; styles in the default theme, `ui-react-radix` and the showcase `brand.css`; `UiReactConformance.CheckTheme` gains a grid scene and checks the reserved properties; a showcase dashboard page using it, with a page-document test under its `tests/`; the hub `build-ui` guide's node table (kept within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library extended rather than added — the responsive screens entry gains the grid; `Added` fragments for `ui`, `ui-react`, `ui-react-radix`, `ui-react-conformance`; a changeset for `@telorun/ui-react-contract`. `ui` adds the node to its own kinds' schemas only, so it needs no `requires:` floor of its own; an application writing `grid` declares its floor, per the grammar rule.

## Verify

- A grid of cells `8` and `4` draws them on one row at two thirds and one third; below `compactBelow` they stack; with `compactColumns: 6` on both they stay side by side.
- Cells `6, 6, 12` draw two rows; a cell whose content has `when: false` is absent from the page document, and one hidden by `shown` leaves no gap while hidden and returns to its place when shown.
- The page document carries both spans on every cell, defaults included; a cell with an extra key is `SCHEMA_VIOLATION`.
- `columns: 13` and `columns: 0` are `SCHEMA_VIOLATION`.
- A theme setting `grid-template-columns` on `grid` is reported by `CheckTheme` as `property-reserved`; both built-in themes and the showcase theme pass.
- The page document carries the grid with every cell's two spans (`Assert.Equals`).

## Example after the change

```yaml
- type: grid
  cells:
    - { columns: 4, compactColumns: 6, content: { type: composite, ref: !ref openCount } }
    - { columns: 4, compactColumns: 6, content: { type: composite, ref: !ref overdueCount } }
    - { columns: 4, content: { type: composite, ref: !ref doneThisWeek } }
    - { columns: 8, content: { type: composite, ref: !ref throughputChart } }
    - { columns: 4, content: { type: composite, ref: !ref recentActivity } }
    - { content: { type: composite, ref: !ref taskTable } }
```
