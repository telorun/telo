import { useContext, useEffect } from "react";
import { resolveAddress, type AddressWire } from "./address-wire.js";
import { conditionHolds, readBinding, ruleStyle, styleAttribute, type Binding, type Condition, type Style, type StyleRule } from "./bindings.js";
import { useHost } from "./host.js";
import { anyCurrent, columnAddresses } from "./record-selection.js";
import type { RowActionSpec } from "./operation.js";
import { RecordLinkContext, RootsContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";
import { useRowActionsDisplay, type ActionsSetting } from "./row-actions-display.js";
import { useSay, useText, type ValueLabel, type WireText } from "./texts.js";
import { TimeValue } from "./time-value.js";
import { Presented, ValueLink } from "./value-cell.js";

/** A column of a list: a value, presented as its schema says, or a date or a date-time drawn as a `time` node draws one. */
export interface ListColumn {
  type?: "time";
  header: WireText;
  value: Binding;
  present?: { type?: unknown; format?: unknown };
  labels?: ValueLabel[];
  shown?: Condition;
  href?: AddressWire;
  /** A time column's: relative to now, or absolute. */
  relative?: boolean;
  style?: StyleRule;
}

/**
 * The rows of a list one answer holds, drawn as a table's grid is, a column per
 * value. A column whose condition does not hold over the roots in scope is
 * left out; a cell reads its row as `row`. `rowStyle` styles each row and a
 * column's `style` each of its cells, both over `row`. Each row offers the list's row
 * actions over `row` and the roots in scope; their answers last as long as the
 * rows they were pressed on.
 */
export function ListView({
  heading,
  rows,
  columns,
  rowActions = [],
  rowActionsDisplay,
  rowStyle,
  style,
  fill = false,
}: {
  heading?: string;
  rows: Binding;
  columns: ListColumn[];
  rowStyle?: StyleRule;
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
            {items.map((row, index) => {
              const scope = { ...roots, row };
              return (
                <tr
                  key={index}
                  data-telo-part="table-row"
                  data-style={styleAttribute(ruleStyle(rowStyle, scope))}
                  data-selected={anyCurrent(columnAddresses(shown, scope, "'list' column href"), location) ? "true" : undefined}
                >
                  {shown.map((column, cell) => {
                    const value = readBinding(column.value, scope);
                    const read = value.present ? value.value : undefined;
                    const href = column.href && resolveAddress(column.href, scope, "'list' column href");
                    return (
                      <td key={cell} data-telo-part="table-cell" data-style={styleAttribute(ruleStyle(column.style, scope))}>
                        <RecordLinkContext.Provider value={true}>
                          {column.type === "time" ? (
                            <ValueLink address={href}>
                              <TimeValue value={read} relative={column.relative === true} />
                            </ValueLink>
                          ) : (
                            <Presented value={read} present={column.present} labels={column.labels} href={href} />
                          )}
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
              );
            })}
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
