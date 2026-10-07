# Ui.Component

Places a custom browser component — on a page, or in a table cell.

| Field | | |
| --- | --- | --- |
| `component` | required | a `!ref` to a [`Ui.ComponentExport`](component-export.md) |
| `props` | | what the component receives, by name |
| `model` | | the shape of the row, when a property reads one |

```yaml
kind: Ui.Component
metadata: { name: pill }
component: !ref Badges.statusPill
model: !ref Todo
props:
  done: !cel "row.isDone"     # read from the row the cell is drawn for
  label: Finished             # the same for every row
```

Each property is an accessor: a fixed value, or a plain chain into `row`,
typed from `model`. The whole `props` map is checked against the properties
the export declares, so a missing, unknown or mistyped one is an error at
`telo check`.

A row-bound property resolves only inside a table cell; anywhere else it has
no row and the component receives nothing for it.

What the component is — how it is written, what it may import, what the host
gives it — is the renderer's contract: see `ui-react`'s component ABI.
