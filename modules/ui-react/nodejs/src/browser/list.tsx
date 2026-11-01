import { useContext, useEffect } from "react";
import { conditionHolds, readBinding, styleAttribute, type Binding, type Condition, type Style } from "./bindings.js";
import type { RowActionSpec } from "./operation.js";
import { RootsContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";
import { useSay, useText, type ValueLabel, type WireText } from "./texts.js";
import { Presented } from "./value-cell.js";

export interface ListColumn {
  header: WireText;
  value: Binding;
  present?: { type?: unknown; format?: unknown };
  labels?: ValueLabel[];
  shown?: Condition;
}

/**
 * The rows of a list one answer holds, drawn as a table's grid is, a column per
 * value. A column whose condition does not hold over the roots in scope is
 * left out; a cell reads its row as `row`. Each row offers the list's row
 * actions over `row` and the roots in scope; their answers last as long as the
 * rows they were pressed on.
 */
export function ListView({
  heading,
  rows,
  columns,
  rowActions = [],
  style,
}: {
  heading?: string;
  rows: Binding;
  columns: ListColumn[];
  rowActions?: RowActionSpec[];
  style?: Style;
}) {
  const roots = useContext(RootsContext);
  const text = useText();
  const say = useSay();
  const read = readBinding(rows, roots);
  const items: unknown[] = read.present && Array.isArray(read.value) ? read.value : [];
  const shown = columns.filter((column) => conditionHolds(column.shown, roots));
  const actions = useRowActions(rowActions, roots, () => {});
  const offered = rowActions.length > 0;
  useEffect(() => actions.clear(), [read.present ? read.value : undefined]);
  return (
    <div data-telo-part="list" data-style={styleAttribute(style)}>
      {heading !== undefined && <h3 data-telo-part="list-heading">{heading}</h3>}
      <div data-telo-part="table-frame">
        <table data-telo-part="table-grid">
          <thead data-telo-part="table-head">
            <tr>
              {shown.map((column, index) => (
                <th key={index} data-telo-part="table-header-cell">
                  {text(column.header)}
                </th>
              ))}
              {offered && <th data-telo-part="table-header-cell" />}
            </tr>
          </thead>
          <tbody data-telo-part="table-body">
            {items.map((row, index) => (
              <tr key={index} data-telo-part="table-row">
                {shown.map((column, cell) => {
                  const value = readBinding(column.value, { ...roots, row });
                  return (
                    <td key={cell} data-telo-part="table-cell">
                      <Presented value={value.present ? value.value : undefined} present={column.present} labels={column.labels} />
                    </td>
                  );
                })}
                {offered && <td data-telo-part="row-actions">{actions.cell(row as Record<string, unknown>, String(index))}</td>}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td data-telo-part="list-empty" colSpan={Math.max(shown.length + (offered ? 1 : 0), 1)}>
                  {say("noRows")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {actions.dialog}
    </div>
  );
}
