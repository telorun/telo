import type { LayoutProps } from "../../../../../nodejs/src/contract/ui-react-layouts.js";

/**
 * A listing layout of ui_react_layouts-2: each record as a chip under the
 * heading it is given once — its press first, then the prop bound to the
 * record (its key without one), then an Open button reporting `onOpen` while
 * the listing opens records — and a button asking for more while more exists.
 */
export function RecordStrip({ props, records, hasMore, loading, can, onEndReached, onOpen }: LayoutProps) {
  return (
    <div data-fixture="strip" data-loading={String(loading)}>
      <h4 data-fixture="strip-title">{String(props.title)}</h4>
      {records.map((record) => (
        <span key={record.key} data-fixture="chip" data-selected={record.selected || undefined}>
          {record.press}
          {record.props.text === undefined ? record.key : String(record.props.text)}
          {can.open && (
            <button type="button" data-fixture="chip-open" onClick={() => onOpen(record.key)}>
              Open
            </button>
          )}
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
