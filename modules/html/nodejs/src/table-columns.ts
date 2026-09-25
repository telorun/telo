/** Which columns a table cell and a column element occupy — the HTML table
 *  model, reduced to what the column combinator (`||`) and `:nth-col()` ask. */

import { isHtmlElement, type ElementNode } from "./html-node.js";
import type { TreeIndex } from "./tree-index.js";

export interface ColumnRange {
  readonly start: number;
  readonly span: number;
}

interface TableColumns {
  readonly cells: Map<ElementNode, ColumnRange>;
  readonly columns: Map<ElementNode, ColumnRange>;
  readonly width: number;
}

function spanOf(element: ElementNode, name: string, fallback: number, max: number): number {
  const value = Number.parseInt(element.attrs[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function rowsOf(table: ElementNode): ElementNode[][] {
  const groups: ElementNode[][] = [];
  let loose: ElementNode[] = [];
  for (const child of table.children) {
    if (child.type !== "element" || child.namespace !== undefined) continue;
    if (child.tag === "tr") loose.push(child);
    else if (["thead", "tbody", "tfoot"].includes(child.tag)) {
      if (loose.length > 0) groups.push(loose);
      loose = [];
      groups.push(child.children.filter((row): row is ElementNode => isHtmlElement(row, "tr")));
    }
  }
  if (loose.length > 0) groups.push(loose);
  return groups;
}

function layout(table: ElementNode): TableColumns {
  const cells = new Map<ElementNode, ColumnRange>();
  const columns = new Map<ElementNode, ColumnRange>();
  let width = 0;

  for (const group of rowsOf(table)) {
    // Slots still held by a cell spanning rows down from an earlier row.
    const held: number[] = [];
    group.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row.children) {
        if (!isHtmlElement(cell, "td") && !isHtmlElement(cell, "th")) continue;
        while ((held[column] ?? 0) > rowIndex) column++;
        const span = spanOf(cell, "colspan", 1, 1000);
        const rawRows = Number.parseInt(cell.attrs.rowspan ?? "", 10);
        const rows = rawRows === 0 ? group.length - rowIndex : spanOf(cell, "rowspan", 1, 65534);
        for (let c = column; c < column + span; c++) held[c] = rowIndex + rows;
        cells.set(cell, { start: column, span });
        column += span;
        width = Math.max(width, column);
      }
    });
  }

  let column = 0;
  for (const group of table.children) {
    if (!isHtmlElement(group, "colgroup")) continue;
    const cols = group.children.filter((col): col is ElementNode => isHtmlElement(col, "col"));
    const start = column;
    if (cols.length === 0) {
      column += spanOf(group, "span", 1, 1000);
    } else {
      for (const col of cols) {
        const span = spanOf(col, "span", 1, 1000);
        columns.set(col, { start: column, span });
        column += span;
      }
    }
    columns.set(group, { start, span: column - start });
  }
  return { cells, columns, width: Math.max(width, column) };
}

const layouts = new WeakMap<ElementNode, TableColumns>();

function tableOf(index: TreeIndex, element: ElementNode): ElementNode | undefined {
  for (let at = index.parentOf(element); at; at = index.parentOf(at)) {
    if (isHtmlElement(at, "table")) return at;
  }
  return undefined;
}

function tableLayout(table: ElementNode): TableColumns {
  let found = layouts.get(table);
  if (!found) {
    found = layout(table);
    layouts.set(table, found);
  }
  return found;
}

/** The columns a `td` / `th` occupies, with its table's width. */
export function cellColumns(
  index: TreeIndex,
  cell: ElementNode,
): { range: ColumnRange; width: number; table: ElementNode } | undefined {
  if (!isHtmlElement(cell, "td") && !isHtmlElement(cell, "th")) return undefined;
  const table = tableOf(index, cell);
  if (!table) return undefined;
  const found = tableLayout(table);
  const range = found.cells.get(cell);
  return range ? { range, width: found.width, table } : undefined;
}

/** The columns a `col` / `colgroup` represents. */
export function columnElementRange(
  index: TreeIndex,
  column: ElementNode,
): { range: ColumnRange; table: ElementNode } | undefined {
  if (!isHtmlElement(column, "col") && !isHtmlElement(column, "colgroup")) return undefined;
  const table = tableOf(index, column);
  if (!table) return undefined;
  const range = tableLayout(table).columns.get(column);
  return range ? { range, table } : undefined;
}

export function rangesOverlap(a: ColumnRange, b: ColumnRange): boolean {
  return a.start < b.start + b.span && b.start < a.start + a.span;
}
