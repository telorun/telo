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
