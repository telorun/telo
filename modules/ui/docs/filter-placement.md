# Filter placements

Where a [filter bar](filters.md)'s controls sit relative to what they filter.
Each way of sitting is a kind, named at the bar's `policy.placement` by `!ref`
or declared inline; `kind:` is the only thing that tells them apart, and each
takes exactly the keys that mean something for it.

```yaml
policy:
  placement:
    kind: Ui.AsidePlacement
    side: end
    compact: { kind: Ui.OverlayPlacement, surface: { kind: Ui.Drawer, side: bottom } }
```

| Kind | Keys (default) | The controls sit |
| --- | --- | --- |
| `Ui.AbovePlacement` | `compact` | in a row above the content |
| `Ui.AsidePlacement` | `side`: `start` \| `end` (`start`); `compact` | in a column beside the content, at that edge |
| `Ui.CollapsiblePlacement` | `open`: boolean (`false`) | above the content, folded behind a toggle |
| `Ui.OverlayPlacement` | `surface`, required | in an overlay opened from a button |

Left out, `placement` is exactly `{ kind: Ui.AbovePlacement }`.

`Ui.FilterPlacement` is the abstract all four extend, and what the bar's slot
is typed by.

## Folding

A collapsible bar and an overlay bar fold their controls away behind a button
showing how many filters hold a value. A field marked `pinned` stays outside
the fold, beside that button, and so do the bar's Apply and Reset. A folding
placement with no unpinned, drawn filter has nothing to fold and draws no
toggle.

- `Ui.CollapsiblePlacement.open` says whether the bar starts unfolded. A bar
  that [keeps its state in a store](state-store.md) remembers its fold — as
  `open` declares it until the viewer folds or unfolds it, their choice from
  then on — and what is stored overrides `open`.
- `Ui.OverlayPlacement.surface` is an overlay [surface](surfaces.md): a
  `Ui.Dialog`, a `Ui.Drawer` or a `Ui.Popover`, with everything that kind
  takes. The overlay always has a Done button, and changes apply as the bar's
  `apply` says while it is open.

  A surface with an `address` puts the open overlay in the page's address:
  opening it adds a history entry, the browser's back closes it, and a link to
  that address opens it. A surface's own `compact` is honoured too.

  A name is one state on its page: an overlay that shares its name with a
  table's create opener opens and closes together with the create form. Give
  the overlay a name of its own unless that is meant.

## On a narrow viewport

`compact` on `Ui.AbovePlacement` and `Ui.AsidePlacement` names the placement
used instead below the application's breakpoint. It takes one that folds — a
`Ui.CollapsiblePlacement` or a `Ui.OverlayPlacement` — and neither of those
has a `compact` of its own, so there is nothing to nest.

## Refused

| | |
| --- | --- |
| a key the kind does not take, `Ui.OverlayPlacement` without `surface` | `SCHEMA_VIOLATION` |
| a `Ui.AbovePlacement` or `Ui.AsidePlacement` at `compact` | `REFERENCE_KIND_MISMATCH` |
| a panel, an inline or a page surface at `Ui.OverlayPlacement.surface` | `REFERENCE_KIND_MISMATCH` |

A bar that pins a field while nothing folds is
[warned](filters.md#warned), on the placement that does not fold.

## What a renderer receives

`Ui.FilterPlacementSpec`, tagged on `type`, one branch per kind and every
member filled:

| `type` | Members |
| --- | --- |
| `above` | `compact?` |
| `aside` | `side`, `compact?` |
| `collapsible` | `open` |
| `overlay` | `surface` — a [`Ui.OverlaySpec`](surfaces.md#what-a-renderer-receives) |

`compact`, where present, is a `collapsible` or an `overlay` branch.
