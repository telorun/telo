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
    show: chosen
    compact: { kind: Ui.OverlayPlacement, surface: { kind: Ui.Drawer, side: bottom } }
```

| Kind | Keys (default) | The controls sit |
| --- | --- | --- |
| `Ui.AbovePlacement` | the [display](#display); `compact` | in a row above the content |
| `Ui.AsidePlacement` | the display; `side`: `start` \| `end` (`start`); `compact` (`{ kind: Ui.CollapsiblePlacement }`) | in a column beside the content, at that edge |
| `Ui.CollapsiblePlacement` | the display; `open`: boolean (`false`) | above the content, folded behind a toggle |
| `Ui.OverlayPlacement` | the display; `surface`, required | in an overlay opened from a button |
| `Ui.SearchBoxPlacement` | `placeholder`: a text (`searchAndFilter`, "Search and filter") | in one search box above the content — [below](#the-search-box) |

Left out, `placement` is exactly `{ kind: Ui.AbovePlacement }`.

`Ui.FilterPlacement` is the abstract all five extend, and what the bar's slot
is typed by. `Ui.FoldingFilterPlacement` is the narrower abstract
`Ui.CollapsiblePlacement` and `Ui.OverlayPlacement` extend, and what every
`compact` slot is typed by.

## Display

The four placements that draw controls take the three members of
`Ui.FilterDisplay`:

| Key | Values (default) | |
| --- | --- | --- |
| `show` | `all` \| `chosen` (`all`) | under `chosen` a filter is on show when it is pinned, was added from the bar's list, or holds a value |
| `controls` | `direct` \| `chips` (`direct`) | under `chips` each filter is a chip naming it and its value, which opens its control |
| `summary` | `none` \| `chips` (`none`) | under `chips`, a row of removable chips, one per filter holding a value |

A `compact` placement that leaves one out takes the value of the placement
holding it, so a bar that shows only the `chosen` filters as chips does so
folded as well. This holds for a `compact` of any kind, one of another module
written through a template included: `ui` reads which members its declaration
wrote and fills the rest. `Ui.SearchBoxPlacement` takes none of them: writing one there
is a `SCHEMA_VIOLATION`.

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
  listing's create opener opens and closes together with the create form. Give
  the overlay a name of its own unless that is meant.

## On a narrow viewport

`compact` on `Ui.AbovePlacement` and `Ui.AsidePlacement` names the placement
used instead below the application's breakpoint. It takes one that folds — a
`Ui.FoldingFilterPlacement`: a `Ui.CollapsiblePlacement`, a
`Ui.OverlayPlacement`, or a kind of your own extending it, accepted with no
change to `ui` — and neither built-in one has a `compact` of its own, so there
is nothing to nest.

A column beside the content leaves no room for the content on a narrow
viewport, so a `Ui.AsidePlacement` always folds there: left out, its `compact`
is exactly `{ kind: Ui.CollapsiblePlacement }`, folded to begin with. A
`Ui.AbovePlacement` has no such default — a row above the content only wraps.

## The search box

`Ui.SearchBoxPlacement` gathers the bar's controls into one search box above
the content. It extends `Ui.FilterPlacement` but not
`Ui.FoldingFilterPlacement`: nothing folds, so it has no `compact`, and a
`pinned` field or `search.pinned` has no effect
([warned](filters.md#warned)). Its one key is `placeholder`, a text shown in the
empty box, the text `searchAndFilter` ("Search and filter") when left out.
`apply`, `state`, presets, defaults and Reset behave as under every placement,
and the bar's state, address spelling and store are the same, so a link to a
filtered page is the same whichever placement draws the bar. Under
`apply: button`, committed chips wait for the Apply button beside the box.

The box shows the search, when it holds text, as a chip worded by the text
`searchChip` ("Search: {$text}"), and each filter holding a value as a chip
worded by `filterChip`; removing a chip clears that filter. A filter with
`control: none` is never a chip.

**Suggestions** are a list under the box, in sections:

- *Empty input:* the presets, then the bar's fields by title (a property
  filtered more than one way, like a range, once per filter, with its caption).
  Picking a field starts a token for it.
- *Typed text with no field prefix:* the search first (when the bar has one),
  then one entry per field the text can be a value for, in the bar's order —
  `contains`, and `eq` / `in` on a string with no `enum` and no relation —
  then the fields whose title or property name starts with the text.
- *After a field prefix:* that field's values — an enum's values and labels, a
  boolean's two, a relation's records read through the relation's `search` and
  drawn with its `label` and `hint`, or typed text for a field taking it. Under
  `values: present`, only the values that occur, with counts honouring the
  bar's search. Under `in`, choices are checkable, the held ones checked, and
  several can be picked. A whole token typed after the prefix is offered first
  as the entry that commits it.

Enter takes the highlighted suggestion, the first starting highlighted; arrow
keys move it while focus stays in the box; Escape closes the list; Backspace in
an empty box removes the last chip, whatever its kind.

**Typed tokens** are `<property><operator><value>`, read from the typed text
and the fields the bar's node carries alone, never from a request. `:` picks
the field's `contains`, else `in`, else `eq`; `=` picks `in`, else `eq`; `>`,
`>=`, `<` and `<=` pick `gt`, `gte`, `lt` and `lte`. The property is matched
ignoring case. Under `in`, commas separate values; under every other operator
the whole text is one value. An enum value matches by its value or its label. A
relation value is never typed: the text after a relation field's prefix is the
query for its record suggestions, and a value is committed only by picking a
record. An enum or boolean value is matched ignoring case, and a filter under
`absent` is never named by a token. An invalid token stays as text and sends
nothing; while nothing is offered for it the box is marked invalid and carries
its reason (`unknown-property`, `operator-unsupported`, `value-not-listed` or
`value-invalid`). Committing a valid one replaces the value its filter held,
under every operator. The rows that pin all of this are
[`conformance/filter-tokens.json`](../conformance/README.md#filter-tokensjson).

## Refused

| | |
| --- | --- |
| a key the kind does not take, `show`, `controls` or `summary` on `Ui.SearchBoxPlacement`, `Ui.OverlayPlacement` without `surface` | `SCHEMA_VIOLATION` |
| a `Ui.AbovePlacement` or `Ui.AsidePlacement` at `compact` | `REFERENCE_KIND_MISMATCH` |
| a panel, an inline or a page surface at `Ui.OverlayPlacement.surface` | `REFERENCE_KIND_MISMATCH` |

A bar that pins a field or the search while nothing ever folds — a
`Ui.AbovePlacement` with no `compact`, a `Ui.SearchBoxPlacement`, or no
placement at all — is [warned](filters.md#warned).
An aside bar always folds on a narrow viewport, so it is never warned.

## What a renderer receives

`Ui.FilterPlacementSpec`, tagged on `type`, one branch per kind and every
member filled:

| `type` | Members |
| --- | --- |
| `above` | `show`, `controls`, `summary`, `compact?` |
| `aside` | `show`, `controls`, `summary`, `side`, `compact` |
| `collapsible` | `show`, `controls`, `summary`, `open` |
| `overlay` | `show`, `controls`, `summary`, `surface` — a [`Ui.OverlaySpec`](surfaces.md#what-a-renderer-receives) |
| `searchBox` | `placeholder` — a text record, or `{ set: Ui.Translations, key: searchAndFilter }` when left out |

`compact`, where present — always on `aside` — is a `collapsible` or an
`overlay` branch carrying the three display members too, filled from the
placement holding it where it wrote none.
