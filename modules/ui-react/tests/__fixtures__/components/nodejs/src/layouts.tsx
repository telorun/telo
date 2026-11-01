import type { LayoutProps } from "../../../../../nodejs/src/contract/ui-react-layouts.js";

/**
 * A listing layout of ui_react_layouts-1: each record as a chip under the
 * heading it is given once, each chip showing the prop bound to the record
 * (its key without one), and a button asking for more while more exists.
 */
export function RecordStrip({ props, records, hasMore, loading, onEndReached }: LayoutProps) {
  return (
    <div data-fixture="strip" data-loading={String(loading)}>
      <h4 data-fixture="strip-title">{String(props.title)}</h4>
      {records.map((record) => (
        <span key={record.key} data-fixture="chip">
          {record.props.text === undefined ? record.key : String(record.props.text)}
          {record.actions}
        </span>
      ))}
      {hasMore && (
        <button type="button" data-fixture="strip-more" onClick={() => onEndReached()}>
          More
        </button>
      )}
    </div>
  );
}
