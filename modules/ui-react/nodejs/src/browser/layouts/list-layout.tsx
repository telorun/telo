import type { LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { Empty, LevelEnd, LevelState, RecordEntry, SortControl, Windowed } from "./layout-kit.js";

/** Records one under another, each drawn with its content: a feed. */
export function ListLayout(props: LayoutProps) {
  const draw = (record: LayoutRecord) => <RecordEntry key={record.key} part="list-item" record={record} />;
  return (
    <>
      <SortControl sort={props.sort} onSortChange={props.onSortChange} />
      <div data-telo-part="list-layout" role="list">
        <Windowed records={props.records} size={props.props.pageSize as number} enabled={props.props.windowed === true} flow="column" draw={draw} />
      </div>
      <LevelState level={props} />
      <Empty props={props} />
      <LevelEnd level={props} scroll={props.paging === "scroll"} word={props.words.loadMore} onEndReached={props.onEndReached} />
    </>
  );
}
