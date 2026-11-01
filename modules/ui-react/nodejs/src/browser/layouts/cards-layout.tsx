import type { LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { Empty, LevelEnd, LevelState, RecordEntry, SortControl, Windowed } from "./layout-kit.js";

/** Records as a grid of cards, each drawn with its content; `size` sets how wide a card is. */
export function CardsLayout(props: LayoutProps) {
  const draw = (record: LayoutRecord) => <RecordEntry key={record.key} part="card" record={record} />;
  return (
    <>
      <SortControl sort={props.sort} onSortChange={props.onSortChange} />
      <div data-telo-part="cards-layout" role="list" data-size={props.props.size as string}>
        <Windowed records={props.records} size={props.props.pageSize as number} enabled={props.props.windowed === true} flow="grid" draw={draw} />
      </div>
      <LevelState level={props} />
      <Empty props={props} />
      <LevelEnd level={props} scroll={props.paging === "scroll"} word={props.words.loadMore} onEndReached={props.onEndReached} />
    </>
  );
}
