import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { LayoutEnd, LayoutLevel, LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { useControl } from "../effective-controls.js";
import { ErrorNode, Loading } from "../nodes.js";
import { useEndReached, useWindowedBlock } from "../record-window.js";

/**
 * What the built-in layouts share: a record's entry, the end of a read, a
 * read's state, the sort control, the "Move to" menu and drag and drop. Each
 * is drawn from the layout contract's props, inside the renderer's words and
 * controls, so a built-in layout is a component of `ui_react_layouts-1` like
 * any other.
 */

/** The control reading the next page of a read: pressed, or under `scroll` when it comes into view. */
export function LevelEnd({ level, at, scroll, word, onEndReached }: { level: LayoutLevel; at?: LayoutEnd; scroll: boolean; word: string; onEndReached: LayoutProps["onEndReached"] }) {
  const reach = () => onEndReached(at);
  const end = useEndReached(scroll, level.hasMore && !level.loading && level.error === undefined, reach);
  if (!level.hasMore) return null;
  return (
    <button data-telo-part="load-more" type="button" ref={end} aria-busy={level.loading ? true : undefined} onClick={reach}>
      {word}
    </button>
  );
}

/** A read's own state where its records would be: loading before it answers, its failure. */
export function LevelState({ level }: { level: LayoutLevel }) {
  if (level.error) return <ErrorNode error={{ type: "error", ...level.error }} />;
  if (level.loading && level.total === undefined && level.records.length === 0) {
    return (
      <div data-telo-part="listing-loading">
        <Loading />
      </div>
    );
  }
  return null;
}

/** The empty state, drawn when every read answered and none holds a record. */
export function Empty({ props }: { props: LayoutProps }) {
  if (props.loading || props.error || props.records.length > 0 || (props.groups ?? []).some((group) => group.loading)) return null;
  return <div data-telo-part="listing-empty">{props.empty}</div>;
}

/** The viewer's sort, for a layout with no headers: a button per sortable property, ascending then descending. */
export function SortControl({ sort, onSortChange }: Pick<LayoutProps, "sort" | "onSortChange">) {
  const Icon = useControl("Icon");
  if (sort.sortable.length === 0) return null;
  return (
    <div data-telo-part="listing-sort" role="group">
      {sort.sortable.map(({ property, label }) => {
        const order = sort.value === property ? "asc" : sort.value === `-${property}` ? "desc" : undefined;
        return (
          <button
            key={property}
            data-telo-part="listing-sort-option"
            type="button"
            data-sorted={order}
            aria-pressed={order !== undefined}
            onClick={() => onSortChange(order === "asc" ? `-${property}` : property)}
          >
            {label}
            <Icon name={order === "asc" ? "sort-ascending" : order === "desc" ? "sort-descending" : "sortable"} />
          </button>
        );
      })}
    </div>
  );
}

/** A place a record can be moved to, as the "Move to" menu offers it. */
export interface Place {
  key: string;
  label: string;
  to: Record<string, unknown>;
}

/** The keyboard path of every move: the places the gesture could drop the record, in a menu. */
export function MoveMenu({ record, places, word, onMove }: { record: LayoutRecord; places: Place[]; word: string; onMove: LayoutProps["onMove"] }) {
  const Menu = useControl("Menu");
  const [open, setOpen] = useState(false);
  if (!record.movable || places.length === 0) return null;
  return (
    <Menu
      open={open}
      items={places.map(({ key, label }) => ({ key, label }))}
      onOpenChange={setOpen}
      onChange={(key) => {
        const place = places.find((each) => each.key === key);
        if (place) onMove(record.key, place.to);
      }}
    >
      <button data-telo-part="record-move" type="button">
        {word}
      </button>
    </Menu>
  );
}

/**
 * One record's entry: its content, its actions, its "Move to" menu and its
 * inline edit form when one is open on it — the element `rowStyle` styles, and
 * the one a drag starts from.
 */
export function RecordEntry({
  part,
  record,
  as: Element = "div",
  drag,
  move,
  children,
}: {
  part: string;
  record: LayoutRecord;
  as?: "div" | "li";
  /** The drag this entry starts, when its record can be moved. */
  drag?: Drag;
  /** The "Move to" menu. */
  move?: ReactNode;
  /** Drawn after the content: a tree item's children. */
  children?: ReactNode;
}) {
  const role = Element === "div" ? "listitem" : undefined;
  return (
    <Element
      data-telo-part={part}
      role={role}
      data-style={record.style}
      data-selected={record.selected ? "true" : undefined}
      {...(drag && record.movable ? drag.source(record.key) : {})}
    >
      {record.props.content as ReactNode}
      {record.actions}
      {move}
      {record.detail}
      {children}
    </Element>
  );
}

/** Drag and drop of records within one layout: a source per record, and targets that take the record dropped on them. */
export interface Drag {
  source(key: string): { draggable: true; onDragStart(event: DragEvent): void; onDragEnd(): void };
  target(take: (key: string) => void): { onDragOver(event: DragEvent): void; onDrop(event: DragEvent): void };
}

const DRAGGED = "text/x-telo-record";

/** Drag and drop over this layout's records. The record dragged is held here, so a drop never reads another page's data. */
export function useDrag(): Drag {
  const dragged = useRef<string | undefined>(undefined);
  return {
    source: (key) => ({
      draggable: true,
      onDragStart: (event) => {
        dragged.current = key;
        event.dataTransfer?.setData(DRAGGED, key);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        dragged.current = undefined;
      },
    }),
    target: (take) => ({
      onDragOver: (event) => {
        if (dragged.current !== undefined) event.preventDefault();
      },
      onDrop: (event) => {
        const key = dragged.current;
        if (key === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        dragged.current = undefined;
        take(key);
      },
    }),
  };
}

/** How a drawn block lays its records out, so they sit as if it were not there: a column, or the rows of its grid. */
export type BlockFlow = "column" | "grid";

const BLOCK_STYLE: Record<BlockFlow, CSSProperties> = {
  column: { display: "flex", flexDirection: "column", gap: "inherit" },
  grid: { gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "subgrid", gap: "inherit" },
};

/**
 * Records in blocks of `size`, each drawn while near the viewport and stood in
 * for at its last height otherwise — unless it holds the focus or the open
 * inline form.
 */
export function Windowed({ records, size, enabled, flow, draw }: { records: LayoutRecord[]; size: number; enabled: boolean; flow: BlockFlow; draw: (record: LayoutRecord) => ReactNode }) {
  if (!enabled) return <>{records.map(draw)}</>;
  const blocks: LayoutRecord[][] = [];
  for (let start = 0; start < records.length; start += size) blocks.push(records.slice(start, start + size));
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} records={block} flow={flow} draw={draw} />
      ))}
    </>
  );
}

function Block({ records, flow, draw }: { records: LayoutRecord[]; flow: BlockFlow; draw: (record: LayoutRecord) => ReactNode }) {
  const [focused, setFocused] = useState(false);
  const block = useWindowedBlock(true, focused || records.some((record) => record.detail !== undefined));
  return (
    <div
      ref={block.ref}
      role="none"
      style={block.drawn ? BLOCK_STYLE[flow] : { height: block.height, gridColumn: "1 / -1" }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Element | null) && setFocused(false)}
    >
      {block.drawn ? records.map(draw) : null}
    </div>
  );
}
