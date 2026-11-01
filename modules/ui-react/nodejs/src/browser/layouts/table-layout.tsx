import { useContext, useState, type ReactNode } from "react";
import { resolveBinding, ruleStyle, styleAttribute, type Binding, type StyleRule } from "../bindings.js";
import { useControl } from "../effective-controls.js";
import type { LayoutProps, ListingDrawing } from "../listing.js";
import type { ListedRecord } from "../listing-engine.js";
import { Loading, Node, type SpecNode } from "../nodes.js";
import { useWindowedBlock } from "../record-window.js";
import { RelatedValue } from "../related-labels.js";
import { RootsContext, RowContext } from "../renderer-context.js";
import { useText, type ValueLabel, type WireText } from "../texts.js";
import { Presented } from "../value-cell.js";

interface Column {
  header: WireText;
  value?: Binding;
  sort?: string;
  relation?: string;
  present?: { type?: unknown; format?: unknown };
  labels?: ValueLabel[];
  style?: StyleRule;
  cell?: SpecNode;
}

/** One record's row, with its inline surface under it when one is open there. */
function TableRow({ record, columns, drawing, span }: { record: ListedRecord; columns: Column[]; drawing: ListingDrawing; span: number }) {
  const roots = useContext(RootsContext);
  const { row } = record;
  return (
    <>
      <tr data-telo-part="table-row" data-style={drawing.rowStyle(row)}>
        {columns.map((column, index) => (
          <td key={index} data-telo-part="table-cell" data-style={styleAttribute(ruleStyle(column.style, { row }))}>
            {column.cell ? (
              <RowContext.Provider value={row}>
                <RootsContext.Provider value={{ ...roots, row }}>
                  <Node node={column.cell} />
                </RootsContext.Provider>
              </RowContext.Provider>
            ) : column.relation !== undefined ? (
              <RelatedValue relation={column.relation} value={resolveBinding(column.value as Binding, { row })} />
            ) : (
              <Presented value={resolveBinding(column.value as Binding, { row })} present={column.present} labels={column.labels} />
            )}
          </td>
        ))}
        {drawing.hasActions && <td data-telo-part="row-actions">{drawing.actions(record)}</td>}
      </tr>
      {drawing.detail?.key === record.key && (
        <tr>
          <td data-telo-part="table-detail" colSpan={span} ref={drawing.detail.ref} />
        </tr>
      )}
    </>
  );
}

/**
 * One page of records: drawn while near the viewport, otherwise stood in for
 * at its last height — unless it holds the focus or the open inline surface.
 */
function TableBlock({ records, columns, drawing, span }: { records: ListedRecord[]; columns: Column[]; drawing: ListingDrawing; span: number }) {
  const [focused, setFocused] = useState(false);
  const keep = focused || records.some((record) => record.key === drawing.detail?.key);
  const block = useWindowedBlock(drawing.windowed, keep);
  return (
    <tbody
      data-telo-part="table-body"
      ref={block.ref}
      onFocus={() => setFocused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Element | null) && setFocused(false)}
    >
      {block.drawn ? (
        records.map((record) => <TableRow key={record.key} record={record} columns={columns} drawing={drawing} span={span} />)
      ) : (
        <tr aria-hidden="true">
          <td colSpan={span} style={{ height: block.height, padding: 0 }} />
        </tr>
      )}
    </tbody>
  );
}

/** A listing's records as a data grid, a column per value; its headers sort. */
export function TableLayout({ spec, drawing }: LayoutProps): ReactNode {
  const Icon = useControl("Icon");
  const text = useText();
  const columns = spec.columns as Column[];
  const span = columns.length + (drawing.hasActions ? 1 : 0);
  const read = drawing.reads[0];
  const sorted = (column: Column) =>
    column.sort === undefined ? undefined : drawing.sort.value === column.sort ? "asc" : drawing.sort.value === `-${column.sort}` ? "desc" : undefined;
  const blocks = (read ? (drawing.windowed ? read.blocks : [read.records]) : []).filter((block) => block.length > 0);
  return (
    <div data-telo-part="table">
      <div data-telo-part="table-frame">
        <table data-telo-part="table-grid">
          <thead data-telo-part="table-head">
            <tr>
              {columns.map((column, index) => {
                const order = sorted(column);
                return (
                  <th key={index} data-telo-part="table-header-cell" data-sorted={order} aria-sort={order === "asc" ? "ascending" : order === "desc" ? "descending" : undefined}>
                    {column.sort === undefined ? (
                      text(column.header)
                    ) : (
                      <button data-telo-part="table-sort" type="button" onClick={() => drawing.sort.sortBy(column.sort as string)}>
                        {text(column.header)}
                        <Icon name={order === "asc" ? "sort-ascending" : order === "desc" ? "sort-descending" : "sortable"} />
                      </button>
                    )}
                  </th>
                );
              })}
              {drawing.hasActions && <th data-telo-part="table-header-cell" />}
            </tr>
          </thead>
          {blocks.map((records, index) => (
            <TableBlock key={index} records={records} columns={columns} drawing={drawing} span={span} />
          ))}
          {drawing.state === "empty" && (
            <tbody data-telo-part="table-body">
              <tr>
                <td data-telo-part="listing-empty" colSpan={span}>
                  {drawing.empty}
                </td>
              </tr>
            </tbody>
          )}
          {drawing.state === "loading" && (
            <tbody data-telo-part="table-body">
              <tr>
                <td data-telo-part="listing-loading" colSpan={span}>
                  <Loading />
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
