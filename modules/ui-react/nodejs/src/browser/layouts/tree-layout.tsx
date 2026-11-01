import { useId } from "react";
import type { LayoutLevel, LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { useControl } from "../effective-controls.js";
import { Empty, LevelEnd, LevelState, MoveMenu, SortControl, useDrag, type Drag, type Place } from "./layout-kit.js";

/** Every record drawn, each with the keys of the records beneath it; a record that would lie beneath itself is drawn once. */
function drawn(level: LayoutLevel, children: Record<string, LayoutLevel>, into: Map<string, { record: LayoutRecord; beneath: Set<string> }>, above = new Set<string>()) {
  for (const record of level.records) {
    if (above.has(record.key)) continue;
    const beneath = new Set<string>();
    const below = children[record.key];
    if (below) {
      drawn(below, children, into, new Set([...above, record.key]));
      for (const child of below.records) {
        beneath.add(child.key);
        for (const deeper of into.get(child.key)?.beneath ?? []) beneath.add(deeper);
      }
    }
    into.set(record.key, { record, beneath });
  }
}

interface Tree {
  props: LayoutProps;
  children: Record<string, LayoutLevel>;
  records: Map<string, { record: LayoutRecord; beneath: Set<string> }>;
  drag: Drag;
}

function TreeItem({ record, tree, above }: { record: LayoutRecord; tree: Tree; above: ReadonlySet<string> }) {
  const Icon = useControl("Icon");
  const { props, children, records, drag } = tree;
  const parent = props.props.parent as string;
  const recordKey = props.props.recordKey as string;
  const name = useId();
  const open = (props.expanded ?? []).includes(record.key);
  const level = children[record.key];
  const beneath = records.get(record.key)?.beneath ?? new Set<string>();
  // Under a record that is not itself, nor beneath it, or back among the roots.
  const places: Place[] = [
    ...(record.row[parent] === null || record.row[parent] === undefined ? [] : [{ key: "", label: props.words.none, to: { [parent]: null } }]),
    ...[...records.values()]
      .filter(({ record: other }) => other.key !== record.key && !beneath.has(other.key) && other.key !== String(record.row[parent] ?? ""))
      .map(({ record: other }) => ({ key: other.key, label: String(other.props.title ?? other.key), to: { [parent]: other.row[recordKey] } })),
  ];
  const takes = (key: string) => {
    if (key === record.key || beneath.has(key) || String(records.get(key)?.record.row[parent] ?? "") === record.key) return;
    props.onMove(key, { [parent]: record.row[recordKey] });
  };
  return (
    <li
      data-telo-part="tree-item"
      role="treeitem"
      aria-expanded={open}
      aria-labelledby={name}
      data-style={record.style}
      data-selected={record.selected ? "true" : undefined}
      {...(props.can.move && record.movable ? drag.source(record.key) : {})}
      {...(props.can.move ? drag.target(takes) : {})}
    >
      <button data-telo-part="tree-toggle" type="button" aria-expanded={open} aria-labelledby={name} onClick={() => props.onExpand(record.key, !open)}>
        <Icon name={open ? "collapse" : "expand"} />
      </button>
      <span id={name}>{record.props.content as never}</span>
      {record.actions}
      {props.can.move && <MoveMenu record={record} places={places} word={props.words.moveTo} onMove={props.onMove} />}
      {record.detail}
      {open && (
        <ul data-telo-part="tree-children" role="group">
          {(level?.records ?? [])
            .filter((child) => !above.has(child.key) && child.key !== record.key)
            .map((child) => (
              <TreeItem key={child.key} record={child} tree={tree} above={new Set([...above, record.key])} />
            ))}
          {level && (
            <li role="none">
              <LevelState level={level} />
              <LevelEnd level={level} at={{ parent: record.key }} scroll={false} word={props.words.loadMore} onEndReached={props.onEndReached} />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * Records as a hierarchy: the roots, then a record's children under it once
 * it is expanded, each level paged by "Load more". A record dropped onto
 * another — or moved there through its "Move to" menu — is reparented under
 * it; dropped on the tree itself, or moved to none, it becomes a root.
 */
export function TreeLayout(props: LayoutProps) {
  const drag = useDrag();
  const children = props.children ?? {};
  const records = new Map<string, { record: LayoutRecord; beneath: Set<string> }>();
  drawn(props, children, records);
  const tree: Tree = { props, children, records, drag };
  const parent = props.props.parent as string;
  const toRoot = (key: string) => {
    const held = records.get(key)?.record.row[parent];
    if (held !== null && held !== undefined) props.onMove(key, { [parent]: null });
  };
  return (
    <>
      <SortControl sort={props.sort} onSortChange={props.onSortChange} />
      <ul data-telo-part="tree-layout" role="tree" {...(props.can.move ? drag.target(toRoot) : {})}>
        {props.records.map((record) => (
          <TreeItem key={record.key} record={record} tree={tree} above={new Set()} />
        ))}
      </ul>
      <LevelState level={props} />
      <Empty props={props} />
      <LevelEnd level={props} scroll={false} word={props.words.loadMore} onEndReached={props.onEndReached} />
    </>
  );
}
