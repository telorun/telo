# Nodes

A page is a tree of nodes. A node is plain data with a `type`; the shape is
`Ui.Node`, and a kind takes one with `$ref: "telo://Ui/Node"`.

| `type` | Fields | Is |
| --- | --- | --- |
| `box` | `children` | a group |
| `stack` | `children` | its children one under another |
| `columns` | `children` | its children side by side |
| `text` | `text` | a run of text |
| `badge` | `text` | a short label |
| `link` | `text`, `href` | a link |
| `image` | `src`, `alt` | an image |
| `svg` | `markup`, `alt` | SVG markup, drawn as an image |
| `composite` | `ref` | a [composite](composite.md): a `!ref`, or an inline declaration |

Every node also takes:

- `style` — one name from the style list, or a list of them.
- `when` — a boolean, `true` when left out. A node whose `when` is false is
  left out of its parent.

Each `type` is a closed shape: a key it does not take is an error naming the
key, and a `type` outside the list is an error listing the valid ones.

There is no layout field — no gap, alignment, width or image size — and no
button. How nodes are arranged is the renderer's styling contract; a button is
a composite — a [`Ui.Action`](action.md), or what a table offers on its rows.

## Addresses

- `link.href` is an app-relative path (`/done`), or starts with `https://`,
  `http://` or `mailto:`. Anything else is refused.
- `image.src` is an app-relative path or starts with `https://` or `http://`.
  `alt` is required and may be empty for a decorative image.
- An app-relative path is `/` followed by anything other than `/` or `\`,
  with no control character (a tab, a line break) anywhere in it.

  | Written | |
  | --- | --- |
  | `/`, `/done`, `/a//b` | app-relative |
  | `//host/x`, `/\host/x` | refused: a browser reads it as another host |
  | `/` followed by a tab, then `/x` | refused: a browser drops the tab and reads `//x` |

  The same rule holds for a table's and a form's `source.basePath` and an
  action's `source.path`. A literal
  one is refused by `telo check`; a computed `href` or `src` that breaks it is
  replaced by an `error` node for that request.
- An app-relative path is the application's own: a renderer mounted under a
  prefix resolves both under that prefix.
- `svg.markup` is never inserted into the page. A renderer draws it as an
  image, so nothing in it can run or reach the document.

## Styles

A closed list. A style says what a node means; the theme decides how that
looks.

| Style | Meaning |
| --- | --- |
| `heading` | a section heading (a level-2 heading element on `text`) |
| `subheading` | a heading below it (level 3) |
| `muted` | secondary |
| `strong` | emphasised |
| `accent` | in the accent colour |
| `danger` | an error or a destructive thing |
| `warning` | needs attention |
| `success` | went well |

A theme token name is never a style value.

## Style rules

Where a style depends on data — a row, a cell — it is a rule, not a callback:

```yaml
rowStyle:
  by: !cel "row.status"
  cases:
    overdue: danger
    done: [muted, strong]
  default: strong
```

`by` is an [accessor](https://telo.run/docs/extend/accessor-fields): a plain
chain into the row, or a fixed value. A case key is matched against the plain
text of the value — `true`, `false`, a number's digits, a string as it is. A
null value takes `default`; a value no case names takes `default` too.

## What a renderer receives

`Ui.SpecNode` is the same vocabulary after resolution: every `when` decided,
every composite replaced by the node it provides (`table`, `form`, `action`,
`filters`, `component`), and `error` for a node that could not be produced. It carries no
resource name. Row-bound values in it are **bindings** — `{ root, path }` for a
chain, `{ value }` for a literal — which a renderer resolves by following the
path; no expression engine runs in the browser.

**A node carries every presentation member, declared or not.** A `table` node's
`create` and `edit` are each `{ form, surface, afterSubmit, unsaved }`, all four
present: `form` the form node, `surface` a [`Ui.SurfaceSpec`](surfaces.md#what-a-renderer-receives)
with every member its kind has, `afterSubmit` and `unsaved` as declared or
defaulted. The defaults are this module's, filled before the node is provided,
so two renderers cannot disagree about them and none carries a table of its
own.

A `table` node always carries `rowActions`, an empty list when the table
declares none. An entry is `{ path, label, inputs, confirm? }`: `path` and
`label` are the action's, `inputs` maps each input property to a binding, and
`confirm` is present exactly when the entry asks a question.

An `action` node is `{ schema, path, label, fields, lists }`, all five present:
the input model, where the record is sent, the button's text, one
`{ property, label }` per field, and one `{ rows, columns, heading? }` per list
— an empty list when the action draws nothing. `rows` is a binding rooted at
`result`; each column is `{ header, value, present? }`, its `value` a binding
rooted at `row` or `result` and its `header` always filled. See
[what an action provides](action.md#what-a-renderer-receives).

A `filters` node likewise carries its whole policy: `show`, `placement` (a
[`Ui.FilterPlacementSpec`](filter-placement.md#what-a-renderer-receives)),
`controls`, `apply`, `summary`, `state` (`{ address, store, key? }`, `store` a
[`Ui.StateStoreSpec`](state-store.md#what-a-renderer-receives), `key` present
exactly when the bar declared `state`) and `presets` — an empty list when
there are none. Each of its `fields` carries `pinned` and `control`, and
`default` only when one is declared. A default and a preset value are always a
list, whatever was written: one value is a list of one.
