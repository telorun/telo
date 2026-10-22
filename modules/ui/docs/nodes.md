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
| `menu` | `text`, `items` | a button opening a list of links |
| `image` | `src`, `alt` | an image |
| `svg` | `markup`, `alt` | SVG markup, drawn as an image |
| `value` | `value`, `text?` | one value of a data scope, presented as its schema says |
| `list` | `rows`, `columns`, `heading?` | the rows of a list one answer holds, a column per value |
| `composite` | `ref` | a [composite](composite.md): a `!ref`, or an inline declaration |

Every node also takes:

- `style` — one name from the style list, or a list of them.
- `when` — a boolean, `true` when left out: whether the node is **delivered**.
  It is evaluated on the server — per request on a page's own nodes (where it
  may read `request`), once at creation inside a composite — and a node whose
  `when` is false is left out of its parent: it is not sent and holds no state.
- `shown` — a [condition](conditions.md): whether a delivered node is
  **drawn**. It is read in the browser over the roots the place it is written
  binds, and content it hides keeps its state and starts no request. Both keys
  may be present.

## Menus

A `menu` is a button labelled `text` that opens its `items`, each a `link`
node — `text`, `href` and the keys every node takes:

```yaml
- type: menu
  text: Language
  items:
    - { type: link, text: English, href: "/api/lang?set=en", style: strong }
    - { type: link, text: Polski, href: "/api/lang?set=pl" }
    - { type: link, text: Beta features, href: /beta, when: !cel "variables.beta" }
```

Choosing an item follows its `href` exactly as clicking that link would: a
page the application declares is a move within it, anything else an ordinary
load, under the same [address rule](#addresses). An item whose `style` holds
`strong` is the current choice, and a renderer marks it so. Each item is
delivered by its own `when` and drawn by its own `shown`; a menu none of whose
items is delivered is left out, as a node whose `when` is false is. A menu
works anywhere a node does.

## Values and lists

A `value` and a `list` name what they draw with [accessors](https://telo.run/docs/extend/accessor-fields)
over the roots in scope — `data` inside a [`Ui.Data`](data.md), `query` where
query parameters are declared, `error` in a reader's or an action's `failure`,
`result`, `input` and `values` in an [action's answer](action.md#the-answer),
`row` in a list column and its row actions:

```yaml
- type: value
  value: !cel "data.email"
- type: list
  heading: Files
  rows: !cel "data.files"
  columns:
    - value: !cel "row.name"
    - header: Open
      value: !cel "row.url"
      shown: { at: !cel "data.signedIn", matches: { const: true } }
```

A value is presented as its schema says: a `format: uri` / `uri-reference`
string is a link, held to the address rule below, drawn as `text` when that is
given; a date and a time as a date; a boolean as yes or no. A `list` draws the
rows of one answer and is bounded by it — it never pages; a set that grows
without limit is a [`Ui.Table`](table.md) over the collection contract. A
column's header defaults to the `title` of the value it reads, and its `shown`
reads the roots the list is drawn under, never `row`. `row` is typed as an
element of what `rows` names, so `row.nmae` is refused by `telo check`.

A list's `rowActions` offers an action on every row, each entry a
[`Ui.RowAction`](action.md#row-actions) whose `inputs` and `enabled` read `row`
and the roots the list is drawn under; a pressed one draws its action's answer
in place of its button, which lasts as long as the answer the list is drawn
from.

## Texts

Every text a node shows — a `text`, a `badge`, a link's `text`, a menu's
`text` and each of its items', an `alt`, a
value's `text`, a list's `heading` and a column's `header` — is a
`Ui.BoundText`: a [`Text`](https://telo.run/docs/extend/text-records) written in
the module's `lang:`, or `{ text, values }` where the text names values the
page reads:

```yaml
- type: text
  style: heading
  text:
    text: { plural: n, cases: { one: "{$n} unpaid invoice", other: "{$n} unpaid invoices" } }
    values: { n: !cel "data.unpaid" }
```

Each value is an [accessor](https://telo.run/docs/extend/accessor-fields) over
the roots in scope, read in the browser, so the words are composed in the page
and translated as one text — never assembled by the backend. A placeholder the
values do not bind, and one written in a plain text, are refused by `telo
check`. See [Texts and translation](texts.md).

Each `type` is a closed shape: a key it does not take is an error naming the
key, and a `type` outside the list is an error listing the valid ones.

There is no layout field — no gap, alignment, width or image size — and no
button that runs anything. How nodes are arranged is the renderer's styling
contract; a button that runs an operation is a composite — a
[`Ui.Action`](action.md), or what a table offers on its rows — and a `menu`'s
button only opens its links.

## Addresses

- `link.href` — a menu item's included — is an app-relative path (`/done`),
  or starts with `https://`, `http://` or `mailto:`. Anything else is refused.
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
  replaced by an `error` node for that request — for a menu item, the whole
  menu.
- An app-relative path is the application's own: a renderer mounted under a
  prefix resolves every one under that prefix — a `link`'s `href`, an
  `image`'s `src`, a `source.basePath` and an action's `source.path` alike.
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

`Ui.SpecNode` is the same vocabulary after resolution: every `when` decided
and gone — a menu's items included, so a `menu` carries at least one item — every `shown` carried as written (`{ at, matches }`, `at` a binding),
every composite replaced by the node it provides (`table`, `form`, `action`,
`filters`, `data`, `component`), and `error` for a node that could not be
produced. A `value` node carries `present` — what the schema it reads says
(`type`, `format`) — and each `list` column its `header` and `present`, both
resolved on the server; both carry `labels`, the label of each value an
enumeration offers (`[]` when none). Every text is a text record, a
`{ text, values }` text is the record with its `values` beside it, and a text
`ui` fills itself is a word reference `{ word: <id> }` — see
[what a renderer receives](texts.md#what-a-renderer-receives). A composite placed with a `shown` of its own around a
provided node that has one is wrapped in a `box` carrying the placement's, so
both must hold. It carries no resource name. Row-bound values in it are **bindings** — `{ root, path }` for a
chain, `{ value }` for a literal — which a renderer resolves by following the
path; no expression engine runs in the browser.

**A node carries every presentation member, declared or not.** A `table` node's
`create` and `edit` are each `{ form, surface, afterSubmit, unsaved }`, all four
present: `form` the form node, `surface` a [`Ui.SurfaceSpec`](surfaces.md#what-a-renderer-receives)
with every member its kind has, `afterSubmit` and `unsaved` as declared or
defaulted. The defaults are this module's, filled before the node is provided,
so two renderers cannot disagree about them and none carries a table of its
own.

A `table` node always carries `query` (its declared parameters, empty when
none) and `rowActions`, an empty list when the table declares none; a `list`
node carries `rowActions` when it declares them. An entry is
`{ action, inputs, confirm?, prompt?, enabled? }`: `action` is the action's
own node, `inputs` maps each input property to a binding, `confirm` is present
exactly when the entry asks a question, `prompt` — `{ fields }`, the fields its
dialog enters — exactly when the entry declares `prompt: true`, and `enabled`
exactly when the entry declares one.

An `action` node always carries its input model, where the record is sent, the
button's text, one `{ property, label, shown? }` per field, its `failure` tree
(the default filled in), `onSuccess` (`refreshes` empty when none),
`concurrency` and `clearAnswerOn`; `answer` (the output model), `result` and
`enabled` are present exactly when declared. See
[what an action provides](action.md#what-a-renderer-receives). A `data` node is
described in [what a reader provides](data.md#what-a-renderer-receives).

A `filters` node likewise carries its whole policy: `show`, `placement` (a
[`Ui.FilterPlacementSpec`](filter-placement.md#what-a-renderer-receives)),
`controls`, `apply`, `summary`, `state` (`{ address, store, key? }`, `store` a
[`Ui.StateStoreSpec`](state-store.md#what-a-renderer-receives), `key` present
exactly when the bar declared `state`) and `presets` — an empty list when
there are none. Each of its `fields` carries `pinned` and `control`, and
`default` only when one is declared. A default and a preset value are always a
list, whatever was written: one value is a list of one.
