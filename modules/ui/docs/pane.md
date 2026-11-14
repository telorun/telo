# Panes

A pane is a piece of chrome: a navigation bar, a navigation column, an account
menu, a footer of links. `Ui.Pane` is the abstract `Telo.Invocable` every pane
kind extends, and a `pane` node places one:

```yaml
children:
  - { type: text, text: Welcome back, style: title }
  - type: pane
    ref:
      kind: Ui.Navbar
      title: Acme
      navigation:
        items:
          - { type: page, page: !ref home }
          - { type: page, page: !ref reports, when: !cel "'x-role' in request.headers" }
```

| Node key | | |
| --- | --- | --- |
| `ref` | required | the pane: a `!ref`, or an inline declaration |
| `when` | `true` | whether the pane is placed at all, decided where the tree is |
| `shown` | none | a [condition](conditions.md) over the roots the place binds, around what the pane answers |

`ui`'s own panes are [`Ui.Navbar` and `Ui.NavigationColumn`](navigation.md#navigation-panes),
both navigation panes. A pane kind of another module is placed the same way,
with no change to `ui`.

## The contract

A pane is invoked with `{ request? }` — `request` is `{ headers, ip?, lang? }`,
and nothing else is accepted — and answers `{ node? }`: the
[`Ui.SpecNode`](nodes.md#what-a-renderer-receives) drawn in its place, or
nothing, in which case the pane is left out as a node switched off is. On the
wire a pane is replaced by its node: there is no `pane` node a renderer draws.

The node is checked against `Ui.SpecNode` by the contract on every answer, so
an answer that is not a node is refused there (`ERR_OUTPUT_INVALID`). Its
`fill` decided is the pane's: `ui`'s panes, like its composites, mark every
node of what they answer.

## Where a pane is resolved

**A pane is resolved where the tree that places it is resolved** — the rule
`when` already follows:

- In a page's children, or a region of a [page layout](page-layout.md), the
  tree is delivered per request: the pane is invoked per request with
  `{ request }`, after the tree's `when`s, and only when it is delivered.
- Inside a composite — a [`Ui.SplitView`](split-view.md)'s aside, a
  [`Ui.View`](view.md), a reader's content — the tree is resolved once, when
  the composite is created: the pane is invoked once, with `{}`, and its
  answer stands for every request, however many pages place the composite.

A page placing a pane in its own tree varies by every request header (`Vary:
*`), since the pane is handed the whole request.

## `request` is typed from where the pane is placed

One pane kind serves both placements, so whatever in it reads `request`
binds it nullable and typed from the place: a pane kind declares, on the
field holding what reads it,

```yaml
x-telo-context:
  type: object
  properties:
    request:
      x-telo-context-eval: runtime
      x-telo-context-from-referrer: request
      type: [object, "null"]
      properties:
        headers: { type: object, additionalProperties: { type: string } }
        ip: { type: string }
        lang: { type: string }
```

- Placed in a page's children or a layout region, `request` is the place's —
  present — and reads need no guard.
- Placed inside a composite, the place withholds `request`
  (`x-telo-context-withheld`): every read of it, guarded or not, is
  `CEL_UNKNOWN_IDENTIFIER`, naming the composite and the reason — `'request' is
  not available here — the inline Ui.SplitView withholds it: a composite is
  resolved once, at its creation, with no request.` Place the pane in a page's
  children or a layout region, where it is resolved per request, or drop the
  read.
- A pane nothing places — an exported one, checked in its own library — keeps
  its own nullable type, so it guards what it reads (`CEL_NULLABLE_ACCESS`
  otherwise).

Every node-holding region of every composite kind in `ui` withholds `request`
this way. A composite kind of another module withholds it in its own regions by
the same annotation, naming the reason once in a `$defs` entry its regions
point at — `ui`'s own is `telo://Ui/Node#/$defs/CompositeRequest`; a region
that declares no `request` at all leaves a pane placed there its nullable
fallback instead.

## `assets`

A pane answers only a node; the files that node can name — a glyph of an
entry, an icon button's file — are its **published reading** `assets`,
known when it is created: a list in `Ui.Composite`'s `assets` item shape
(`{ digest, name, file, mediaType }`), absent when it names none. A page and a
[page layout](page-layout.md) publish the same member, collecting what the
panes and composites they place publish, so an application serves every file
from boot and never one first learnt from an answer. A file in an answer is
addressed by `{ digest, name }`, as every file a node names.

## A pane of another module

A pane kind is a `Telo.Definition` extending `Ui.Pane`, or
[`Ui.NavigationPane`](navigation.md#navigation-panes) for one drawing a
navigation tree, whose controller answers the contract above and publishes
`assets` from `snapshot()`. `@telorun/ui` exports what `ui`'s own panes are
built with — `preparedNavigation` / `deliveredNavigation`, `RequestNodes` for
nodes delivered per request, `iconAsset` for a glyph's file, and the
`PaneInputs` / `PaneAnswer` types — see
[for a renderer's controller](composite.md#for-a-renderers-controller-telorunui).

```yaml
kind: Telo.Definition
metadata: { name: Links }
capability: Telo.Invocable
extends: Ui.NavigationPane
controllers: [pkg:telo/local/js?path=./nodejs/help.mjs&local_path=./nodejs/src/index.ts#LinksController]
schema:
  type: object
  properties:
    heading: { $ref: "telo://manifest#/$defs/Text", x-telo-text-values: {} }
```

Extended in merge form, as here, it inherits `navigation`, the `request` it
reads, and both navigation rules, with none of its own.
