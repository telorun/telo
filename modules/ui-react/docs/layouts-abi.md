# The layout contract — `ui_react_layouts-1`

What a listing layout component is written against: a browser component
drawing the records a [`Ui.Listing`](../../ui/docs/listing.md) reads, named by a
[`Ui.ComponentLayout`](../../ui/docs/listing-layouts.md#uicomponentlayout) — a
map, a seat plan, a gallery of one's own. The renderer's built-in list, card,
board, calendar, timeline and tree layouts are its reference implementation:
the renderer draws them through this contract, as it draws any other.

A layout component is a **named export** of a browser entry that declares
`abi: ui_react_layouts-1`, published with a
[`Ui.ComponentExport`](../../ui/docs/component-export.md). It is **fully
controlled**: it fetches nothing and holds nothing the renderer holds.

| | The renderer | The component |
| --- | --- | --- |
| Data | reading the plan's reads — every group, period and tree level, each paged; filters, the viewer's sort, reloads after a write, a move or a change announced for the collection; looking up related records' labels | draws `records`, `groups`, `children` and `span` |
| Records | each record's actions — row actions, edit, delete — the inline edit form, the create and edit openers, running a move and drawing its answer | draws each record's `actions` and `detail` where the record is |
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
| `sort` | the viewer's sort, `value`, and each property it may be by with its title, `sortable` |
| `paging` | `more` — `onEndReached` when the viewer asks — or `scroll` — once the end is in view |
| `empty` | the listing's `empty` node, drawn where the records would be when the reads answer none |
| `can` | which of `open`, `create` and `move` does anything |
| `words` | the renderer's words a layout draws, finished: `loadMore`, `moveTo`, `none`, `newRecord` |
| `lang` | the language the page is in |

A record:

| Member | Is |
| --- | --- |
| `key` | the record's key, the collection's `key` property, as text |
| `row` | the record as read |
| `props` | the props bound to `row`, read over this record |
| `labels` | by property with a relation, the related record's label, once looked up |
| `actions` | its row actions, edit, delete and a failed move's answer, drawn by the renderer; `null` when it offers none |
| `detail` | present while its edit form is open in line: drawn under it |
| `style` | the style names `rowStyle` gives it, for its element's `data-style` |
| `selected` | whether it is selected; nothing selects a record in this generation |
| `movable` | whether `onMove` may be reported for it now: the move's `enabled` holds and none of its presses is pending |

A group, beside everything a read holds:

| Member | Is |
| --- | --- |
| `value` | the value its records hold, as read |
| `label` | the value as shown: its label, its related record's, or the value as text |
| `heading` | the label with the group's count, as the `valueCount` word says |
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
| `onOpen` | `(key)` — open the record as the listing's `edit` opener says |
| `onSortChange` | `(sort)` — sort by a property, `-` before it for descending |
| `onMove` | `(key, to)` — run the layout's `move` with `to`, the record as the gesture leaves it; a member it leaves out keeps the row's value |
| `onCreate` | `(values)` — open the create form holding `values`; only the plan's own properties are kept |

A move is never a replace through the edit form, which would lose one of two
concurrent moves: the renderer runs the layout's `move` row action with the
inputs it binds over `row` and `to`, and a 2xx answer reloads every listing
over the collection.

## The built-in layouts

Each is exported under its name and held, by the vectors, to its root part,
the other parts it may draw and the intents it reports.

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
`ui_react_layouts-1` alone. The component ABI `ui_react-1` and the controls
contract `ui_react_controls-2` are separate generations, unchanged by this one.

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
  /** The record's row actions, edit and delete, drawn by the renderer; `null` when it offers none. */
  actions: ReactNode;
  /** Where its inline edit form opens: present while one is open on it, to be drawn under it. */
  detail?: ReactNode;
  /** The style names `rowStyle` gives it, for its element's `data-style`. */
  style?: string;
  /** Whether it is selected. Nothing selects a record in this generation. */
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
 * What a layout component of `ui_react_layouts-1` is given: the outermost read
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
  /** Which of `onOpen`, `onCreate` and `onMove` does anything. */
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
  /** Open a record as its edit opener says. */
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
`span` — and after every step the layout is held to its documented parts. The
built-ins meet every vector inside the renderer's words, in a happy-dom window.

## How the generation grows

For the life of `ui_react_layouts-1` a prop or a member is added only where a
component ignoring it still meets the contract, and the supplied specifiers
only grow. A new intent, a new required behaviour or a change to what a prop
holds is the next generation.
