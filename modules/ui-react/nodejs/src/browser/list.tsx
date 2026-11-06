import { useContext, useEffect } from "react";
import { resolveAddress, type AddressWire } from "./address-wire.js";
import { conditionHolds, readBinding, styleAttribute, type Binding, type Condition, type Style } from "./bindings.js";
import { useHost } from "./host.js";
import { anyCurrent, columnAddresses } from "./record-selection.js";
import type { RowActionSpec } from "./operation.js";
import { RecordLinkContext, RootsContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";
import { useRowActionsDisplay, type ActionsSetting } from "./row-actions-display.js";
import { useSay, useText, type ValueLabel, type WireText } from "./texts.js";
import { Presented } from "./value-cell.js";

export interface ListColumn {
  header: WireText;
  value: Binding;
  present?: { type?: unknown; format?: unknown };
  labels?: ValueLabel[];
  shown?: Condition;
  href?: AddressWire;
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
  rowActionsDisplay,
  style,
  fill = false,
}: {
  heading?: string;
  rows: Binding;
  columns: ListColumn[];
  rowActions?: RowActionSpec[];
  rowActionsDisplay: ActionsSetting;
  style?: Style;
  /** Whether the list is a node filling the room it is in. */
  fill?: boolean;
}) {
  const roots = useContext(RootsContext);
  const { location } = useHost();
  const text = useText();
  const say = useSay();
  const read = readBinding(rows, roots);
  const items: unknown[] = read.present && Array.isArray(read.value) ? read.value : [];
  const shown = columns.filter((column) => conditionHolds(column.shown, roots));
  const actions = useRowActions(rowActions, roots, () => {});
  const offered = rowActions.length > 0;
  const shownActions = useRowActionsDisplay(rowActionsDisplay, `${items.length}|${rowActions.length}`);
  useEffect(() => actions.clear(), [read.present ? read.value : undefined]);
  return (
    <div data-telo-part="list" data-fill={fill ? "true" : undefined} data-style={styleAttribute(style)} ref={shownActions.container}>
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
              <tr key={index} data-telo-part="table-row" data-selected={anyCurrent(columnAddresses(shown, { ...roots, row }, "'list' column href"), location) ? "true" : undefined}>
                {shown.map((column, cell) => {
                  const scope = { ...roots, row };
                  const value = readBinding(column.value, scope);
                  return (
                    <td key={cell} data-telo-part="table-cell">
                      <RecordLinkContext.Provider value={true}>
                        <Presented
                          value={value.present ? value.value : undefined}
                          present={column.present}
                          labels={column.labels}
                          href={column.href && resolveAddress(column.href, scope, "'list' column href")}
                        />
                      </RecordLinkContext.Provider>
                    </td>
                  );
                })}
                {offered && (
                  <td data-telo-part="row-actions" data-display={shownActions.display} ref={shownActions.area}>
                    {shownActions.display === "menu"
                      ? actions.menuCell(row as Record<string, unknown>, String(index))
                      : actions.cell(row as Record<string, unknown>, String(index))}
                  </td>
                )}
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
