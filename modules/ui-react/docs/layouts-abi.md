# The layout contract — `ui_react_layouts-2`

What a listing layout component is written against: a browser component
drawing the records a [`Ui.Listing`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) reads, named by a
[`Ui.ComponentLayout`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) — a
map, a seat plan, a gallery of one's own. The renderer's built-in list, card,
board, calendar, timeline and tree layouts are its reference implementation:
the renderer draws them through this contract, as it draws any other.

A layout component is a **named export** of a browser entry that declares
`abi: ui_react_layouts-2`, published with a
[`Ui.ComponentExport`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/). It is **fully
controlled**: it fetches nothing and holds nothing the renderer holds.

| | The renderer | The component |
| --- | --- | --- |
| Data | reading the plan's reads — every group, period and tree level, each paged; filters, the viewer's sort, reloads after a write, a move or a change announced for the collection; looking up related records' labels | draws `records`, `groups`, `children` and `span` |
| Records | each record's press and whether it leads to where the viewer is, each record's actions — row actions, edit, delete — the inline edit form, the create and edit openers, running a move and drawing its answer | draws each record's `press` first in the element it covers, sets `data-selected` from `selected`, and draws `actions` and `detail` where the record is |
| Intents | what each one does | reports `onEndReached`, `onPeriodChange`, `onExpand`, `onOpen`, `onSortChange`, `onMove`, `onCreate` |
| Text | every word, finished, and `lang` | formats nothing it is not given but dates, in `lang` |

## What it receives

Each prop of the layout is an accessor: one bound to `row` is read over each
record and delivered on it as `record.props`, every other once, as `props`.

| Prop | Is |
| --- | --- |
| `records` | every record of the outermost read, in the listing's sort order — under `groups`, every group's records in turn |
| `total` | every record the outermost read matches, from the collection's `total`; absent until it answers, and under `groups` |
| `hasMore` | whether `onEndReached()` reads more: a further page, or under `groups` further groups |
| `loading` | whether a page of the outermost read is being read — under `groups`, of the groups' values |
| `error` | the first read that failed, `{ code, message }` |
| `children` | under `parent`: each expanded record's children, by its key, at any depth |
| `props` | the props not bound to `row`, given once |
| `groups` | under `groups`: each group, in order |
| `span` | under `span`: the period shown, `{ from, to }`; `null` until `onPeriodChange` names one |
| `expanded` | under `parent`: the keys of the records whose children are read |
| `sort` | the viewer's sort, `value` — the order the listing starts in until another is chosen — and each property it may be by with its title, `sortable`; none when the listing's order is fixed |
| `paging` | `more` — `onEndReached` when the viewer asks — or `scroll` — once the end is in view |
| `empty` | the listing's `empty` node, drawn where the records would be when the reads answer none |
| `can` | which of `open` — the listing has a press or an `edit` opener — `create` and `move` does anything |
| `words` | the renderer's own texts a layout draws, finished: `loadMore`, `moveTo`, `none`, `newRecord` |
| `lang` | the language the page is in |

A record:

| Member | Is |
| --- | --- |
| `key` | the record's key, the collection's `key` property, as text |
| `row` | the record as read |
| `props` | the props bound to `row`, read over this record |
| `labels` | by property with a relation, the related record's label, once looked up |
| `press` | the element the renderer draws for the listing's [press](#the-record-press), `null` without one: drawn as the first child of the element it covers |
| `actions` | its row actions, edit, delete and a failed move's answer, drawn by the renderer — as buttons or one menu button, the wrapping element's `data-display` saying which; `null` when it offers none |
| `detail` | present while its edit form is open in line: drawn under it |
| `style` | the style names `rowStyle` gives it, for its element's `data-style` |
| `selected` | whether the record's press leads to where the viewer is (see [the current location](styling.md#state)) — and, for a built-in layout, a link its content draws; the component sets `data-selected` from it on the element its press covers |
| `movable` | whether `onMove` may be reported for it now: the move's `enabled` holds and none of its presses is pending |

A group, beside everything a read holds:

| Member | Is |
| --- | --- |
| `value` | the value its records hold, as read |
| `label` | the value as shown: its label, its related record's, or the value as text |
| `heading` | the label with the group's count, as the `valueCount` text says |
| `records` | its records |
| `total` | its read's `total` |
| `hasMore` | whether `onEndReached({ group })` reads more of it |
| `loading` | whether a page of it is being read |
| `error` | its read's failure |
| `children` | under `parent`: its expanded records' children |

## Intents

| Intent | Does |
| --- | --- |
| `onEndReached` | `(at?)` — read the next page: of the outermost read with no `at`, of a group with `{ group }`, of a tree level with `{ parent }` |
| `onPeriodChange` | `(period)` — show another period: what a `span` plan reads; sets `span` |
| `onExpand` | `(key, open)` — read a record's children, or stop reading them |
| `onOpen` | `(key)` — run the record's press, else open it as the listing's `edit` opener says; what `can.open` reports |
| `onSortChange` | `(sort)` — sort by a property, `-` before it for descending |
| `onMove` | `(key, to)` — run the layout's `move` with `to`, the record as the gesture leaves it; a member it leaves out keeps the row's value |
| `onCreate` | `(values)` — open the create form holding `values`; only the plan's own properties are kept |

A move is never a replace through the edit form, which would lose one of two
concurrent moves: the renderer runs the layout's `move` row action with the
inputs it binds over `row` and `to`, and a 2xx answer reloads every listing
over the collection.

## The record press

A listing's `press` says what pressing a record does. The renderer draws it as
an element — a real link to where it leads, named by the press's label — and
hands it over as `record.press`; a component places it as the **first child of
the element it covers**, the record's root or one part of it, and sets
`data-selected` there from `record.selected`. The geometry is the renderer's
base layer's, so a component restates none of it: the press is stretched
across the element holding it, that element is its containing block, and
every link, button, form control, `label`, `summary`, `[tabindex]` and
`[contenteditable]` after the press inside it is positioned, so each paints
above the press and stays a target of its own — `record.actions` included.

What a component draws around it keeps that working:

- The element holding the press is **never `position: static`**: the base
  layer positions it, and a rule of the component's setting `static` lets the
  press escape to the next positioned ancestor.
- A **non-interactive** element the component positions inside a record — a
  corner badge, a positioned image — paints above the press too, so it takes
  `pointer-events: none` and a pointer on it still lands on the press.
- Text inside the covered element cannot be selected by dragging across it;
  cover one part of the record when the rest must stay selectable, as the
  table covers its first cell.

Without a press `record.press` is `null`, and a record is opened, where the
listing edits, through `onOpen`, as before. A gallery drawing it:

```yaml
kind: Telo.Library
metadata:
  name: GalleryLayout
  version: 1.0.0
  description: A gallery of records drawn by a browser component, each record opening as its listing's press says.
imports:
  Ui: oci://ghcr.io/telorun/ui
exports:
  resources: [gallery]
  browser:
    - specifier: "@example/gallery"
      path: ./browser/gallery.js
      source: ./browser/src/gallery.tsx
      abi: ui_react_layouts-2
      external: [react]
      exports: [Gallery]
---
kind: Ui.ComponentExport
metadata: { name: gallery }
entry: "@example/gallery"
export: Gallery
props: { kind: Telo.JsonSchema, schema: { type: object, additionalProperties: false, properties: {} } }
```

```tsx
import type { LayoutProps } from "@telorun/ui-react-contract";

export function Gallery({ records }: LayoutProps) {
  return (
    <ul className="gallery">
      {records.map((record) => (
        <li key={record.key} className="gallery-item" data-selected={record.selected || undefined}>
          {record.press}
          <h3>{String(record.row.title)}</h3>
          {record.actions}
        </li>
      ))}
    </ul>
  );
}
```

## The built-in layouts

Each is exported under its name and held, by the vectors, to its root part,
the other parts it may draw, the intents it reports, and to drawing each
record's press as the first child of the record's element — the list item,
card, board card, calendar event, timeline bar or tree item — which carries
`data-selected` while the record is selected. The renderer's table, which is
no component of this contract, draws the press across each row's first cell
instead, the row carrying `data-selected`.

| Type | Export | Root part | Sub-parts |
| --- | --- | --- | --- |
| `list` | `ListLayout` | `list-layout` | `error`, `error-code`, `error-message`, `icon`, `list-item`, `listing-empty`, `listing-loading`, `listing-sort`, `listing-sort-option`, `load-more`, `loading` |
| `cards` | `CardsLayout` | `cards-layout` | `card`, `error`, `error-code`, `error-message`, `icon`, `listing-empty`, `listing-loading`, `listing-sort`, `listing-sort-option`, `load-more`, `loading` |
| `board` | `BoardLayout` | `board-layout` | `board-card`, `board-cards`, `board-column`, `board-heading`, `error`, `error-code`, `error-message`, `icon`, `listing-empty`, `listing-loading`, `listing-sort`, `listing-sort-option`, `load-more`, `loading`, `menu`, `menu-item`, `record-create`, `record-move`, `tooltip` |
| `calendar` | `CalendarLayout` | `calendar-layout` | `calendar-day`, `calendar-day-label`, `calendar-event`, `calendar-grid`, `calendar-header`, `calendar-next`, `calendar-period`, `calendar-prev`, `calendar-title`, `calendar-weekday`, `error`, `error-code`, `error-message`, `icon`, `listing-empty`, `listing-loading`, `loading`, `menu`, `menu-item`, `record-create`, `record-move`, `tooltip` |
| `timeline` | `TimelineLayout` | `timeline-layout` | `error`, `error-code`, `error-message`, `icon`, `listing-empty`, `listing-loading`, `load-more`, `loading`, `menu`, `menu-item`, `record-move`, `timeline-axis`, `timeline-bar`, `timeline-header`, `timeline-lane`, `timeline-lane-label`, `timeline-next`, `timeline-prev`, `timeline-scale`, `timeline-tick`, `timeline-title`, `timeline-track`, `tooltip` |
| `tree` | `TreeLayout` | `tree-layout` | `error`, `error-code`, `error-message`, `icon`, `listing-empty`, `listing-loading`, `listing-sort`, `listing-sort-option`, `load-more`, `loading`, `menu`, `menu-item`, `record-move`, `tree-children`, `tree-item`, `tree-toggle` |

Every move a built-in layout offers has a keyboard path: a record's "Move to"
`menu`, offering the places a drop would put it — another column, a day, a
column or a lane of the timeline, another record of the tree or none.
Resizing an event or a bar is not offered in this generation.

A listing's frame, and `data-embedded`, belong to the built-in layouts: a
component layout draws no mark the renderer could set, so one placed directly
in a flush split view's content draws whatever frame it draws itself, inside
the split's. The contract carries no such mark in this generation, so a
component that is meant to sit in a flush split draws none of its own.

## What it may leave to the page

An entry may list as `external` only these specifiers; anything else is
bundled into it.

| Specifier |
| --- |
| `react` |
| `react/jsx-runtime` |
| `react-dom` |
| `@telorun/ui-react` |

## Hosting

A renderer checks each listing's `layout` and `compact` when the application
starts: a component layout whose entry declares another ABI than the layout
contracts it hosts, or imports a specifier the page does not supply, is
refused as `ERR_UI_COMPONENT_ABI_UNSUPPORTED` or
`ERR_UI_COMPONENT_IMPORT_UNSUPPLIED`, as for a `Ui.Component`, and that listing
is drawn as the error node in its place. This renderer hosts
`ui_react_layouts-2` alone: a component built for `ui_react_layouts-1` is
refused, the message naming `ui_react_layouts-2`, and is rebuilt against it. The component ABI `ui_react-1` and the controls
contract `ui_react_controls-4` are separate generations, unchanged by this one.

## The declaration

```ts
import type { ReactNode } from "react";

/** A read that failed, as the renderer reports it. */
export interface LayoutError {
  code: string;
  message: string;
}

/** One record, as the renderer hands it to a layout. */
export interface LayoutRecord {
  /** The record's key: the collection's `key` property, as text. */
  key: string;
  /** The record as read. */
  row: Record<string, unknown>;
  /** The props bound to `row`, read over this record. */
  props: Record<string, unknown>;
  /** By property with a relation, the label of the related record it names, once known. */
  labels: Record<string, string>;
  /** The element the renderer draws for the listing's press, `null` without one: drawn as the first child of the element it covers — the record's root, or one part of it. */
  press: ReactNode;
  /** The record's row actions, edit and delete, drawn by the renderer; `null` when it offers none. */
  actions: ReactNode;
  /** Where its inline edit form opens: present while one is open on it, to be drawn under it. */
  detail?: ReactNode;
  /** The style names `rowStyle` gives it, for its element's `data-style`. */
  style?: string;
  /** Whether its press leads to where the viewer is — for a built-in layout, or a link its content draws; the record's element carries `data-selected` from it. */
  selected: boolean;
  /** Whether `onMove` may be reported for it. */
  movable: boolean;
}

/** One read: a list, a group, or a tree level. */
export interface LayoutLevel {
  /** Every record drawn, in the listing's sort order, each key once. */
  records: LayoutRecord[];
  /** Every record the read matches, from the collection's `total`; absent until it answers. */
  total?: number;
  /** Whether `onEndReached` reads more of it. */
  hasMore: boolean;
  /** Whether a page of it is being read. */
  loading: boolean;
  error?: LayoutError;
  /** Under a `parent` plan: the children of each record expanded beneath this read, at any depth, by its key. */
  children?: Record<string, LayoutLevel>;
}

/** One group of a `groups` plan: a column of a board, a lane of a timeline. */
export interface LayoutGroup extends LayoutLevel {
  /** The value its records hold, as read. */
  value: unknown;
  /** What the value is shown as: its label, its related record's, or the value as text. */
  label: string;
  /** The label with the group's count, as the renderer words it. */
  heading: string;
}

/** A shown period: its first and last instant, written as the plan's `span` is. */
export interface LayoutPeriod {
  from: string;
  to: string;
}

/** Where `onEndReached` was reached: a group, a tree level, or — with neither — the outermost read. */
export interface LayoutEnd {
  group?: unknown;
  parent?: string;
}

/**
 * What a layout component of `ui_react_layouts-2` is given: the outermost read
 * (the only read, a tree's roots, or under `groups` every group's records),
 * the plan's dimensions where it has them, and what it reports. It fetches
 * nothing and holds nothing the renderer holds.
 */
export interface LayoutProps extends LayoutLevel {
  /** The props not bound to `row`, given once. */
  props: Record<string, unknown>;
  /** Under a `groups` plan, in order; then `hasMore` says whether more groups exist. */
  groups?: LayoutGroup[];
  /** Under a `span` plan: the shown period, `null` until `onPeriodChange` names one. */
  span?: LayoutPeriod | null;
  /** Under a `parent` plan: the records whose children are read. */
  expanded?: string[];
  /** The viewer's sort, and each property it may be by with its title. */
  sort: { value?: string; sortable: { property: string; label: string }[] };
  /** How a further page of the outermost read is reached: `more` when asked, `scroll` once its end is in view. */
  paging: "more" | "scroll";
  /** Drawn where the records would be when the reads answer none. */
  empty: ReactNode;
  /** Which of `onOpen`, `onCreate` and `onMove` does anything: `open` while the listing has a press or an edit opener. */
  can: { open: boolean; create: boolean; move: boolean };
  /** The renderer's words a layout draws, finished. */
  words: { loadMore: string; moveTo: string; none: string; newRecord: string };
  /** The language the page is in. */
  lang: string;
  /** Read the next page where the end was reached. */
  onEndReached(at?: LayoutEnd): void;
  /** Show another period: what a `span` plan reads. */
  onPeriodChange(period: LayoutPeriod): void;
  /** Read, or stop reading, a record's children. */
  onExpand(key: string, open: boolean): void;
  /** Run a record's press, else open it as its edit opener says. */
  onOpen(key: string): void;
  /** Sort by a property, `-` before it for descending. */
  onSortChange(sort: string): void;
  /** Run the move: `to` is the record as the gesture leaves it; what it leaves out keeps the row's value. */
  onMove(key: string, to: Record<string, unknown>): void;
  /** Open the create form with these values: only the plan's own properties are kept. */
  onCreate(values: Record<string, unknown>): void;
}
```

## Vectors and the interpreter

The contract ships in the code entry `@telorun/ui-react-contract`, beside the
controls contract: `layouts` — this contract's props, the members of a record
and of a group, its intents and each built-in's parts — and `layoutVectors` —
per built-in layout, the props every vector starts from and each behaviour
vector. `runLayoutVector` runs one, as `runVector` runs a control's (see
[the controls contract](controls-abi.md#vectors-scenes-and-the-interpreter)):
an intent reported is applied to the prop it sets — `onPeriodChange` sets
`span` — and after every step the layout is held to its documented parts. An
expectation's `firstChild` (`{ of, is }`) holds that the first element child of
`of` is the element `is` names. The
built-ins meet every vector inside the renderer's own texts, in a happy-dom window.

## How the generation grows

`ui_react_layouts-2` differs from `ui_react_layouts-1` in:

- a record's `press`, which a component draws first in the element it covers —
  a new required behaviour;
- `selected`, which reports the press for every layout, a component's included;
- `onOpen`, which runs the press where the listing has one, and `can.open`,
  which holds for a press or an `edit` opener;
- one interpreter term, the `firstChild` of an expectation.

For the life of `ui_react_layouts-2` a prop or a member is added only where a
component ignoring it still meets the contract, and the supplied specifiers
only grow. A new intent, a new required behaviour or a change to what a prop
holds is the next generation.
