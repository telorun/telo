import type { LayoutGroup, LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { IconButton } from "../icon-button.js";
import { Empty, LevelEnd, LevelState, MoveMenu, RecordEntry, SortControl, useDrag, type Place } from "./layout-kit.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A kanban board: a column per group, headed by its label and count, each
 * paged on its own by "Load more". A card dragged onto another column — or
 * moved there through its "Move to" menu — is moved with the column's value
 * as `to.<property>`; order within a column is the listing's sort.
 */
export function BoardLayout(props: LayoutProps) {
  const property = props.props.group as string;
  const groups = props.groups ?? [];
  const drag = useDrag();
  const placesFor = (group: LayoutGroup): Place[] =>
    groups.flatMap((other, index) => (same(other.value, group.value) ? [] : [{ key: String(index), label: other.label, to: { [property]: other.value } }]));
  const moveInto = (group: LayoutGroup) => (key: string) => {
    if (group.records.some((record) => record.key === key)) return;
    props.onMove(key, { [property]: group.value });
  };
  const card = (group: LayoutGroup) => (record: LayoutRecord) => (
    <RecordEntry
      key={record.key}
      part="board-card"
      as="li"
      record={record}
      drag={props.can.move ? drag : undefined}
      move={props.can.move && <MoveMenu record={record} places={placesFor(group)} word={props.words.moveTo} onMove={props.onMove} />}
    />
  );
  return (
    <>
      <SortControl sort={props.sort} onSortChange={props.onSortChange} />
      <div data-telo-part="board-layout">
        {groups.map((group, index) => (
          <section key={index} data-telo-part="board-column" aria-label={group.label} {...(props.can.move ? drag.target(moveInto(group)) : {})}>
            <div data-telo-part="board-heading">
              <span>{group.heading}</span>
              {props.can.create && (
                <IconButton part="record-create" label={props.words.newRecord} icon="add" onClick={() => props.onCreate({ [property]: group.value })} />
              )}
            </div>
            <ol data-telo-part="board-cards">{group.records.map(card(group))}</ol>
            <LevelState level={group} />
            <LevelEnd level={group} at={{ group: group.value }} scroll={false} word={props.words.loadMore} onEndReached={props.onEndReached} />
          </section>
        ))}
        <LevelEnd level={props} scroll={false} word={props.words.loadMore} onEndReached={props.onEndReached} />
      </div>
      <LevelState level={props} />
      <Empty props={props} />
    </>
  );
}
