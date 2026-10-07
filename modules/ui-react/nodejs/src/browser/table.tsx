import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { presentValue, resolveBinding, ruleStyle, styleAttribute, type Binding, type StyleRule } from "./bindings.js";
import { fetchPage, send, type CollectionPage, type Param } from "./collection.js";
import { ConfirmDialog, Dialog } from "./dialog.js";
import { Form } from "./form.js";
import { useHost } from "./host.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { ErrorNode, Loading, Node, type SpecNode } from "./nodes.js";
import { FilterContext, RowContext } from "./renderer-context.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

interface Column {
  header: string;
  value?: Binding;
  sort?: string;
  present?: { type?: unknown; format?: unknown };
  style?: StyleRule;
  cell?: SpecNode;
}

type Row = Record<string, unknown>;

/**
 * Which rows are shown. The cursors and first-row numbers of the pages visited
 * so far are kept here, in memory, which is what lets "previous" replay a page;
 * a new sort or new filters start a new view.
 */
interface View {
  filters: string;
  sort?: string;
  page: number;
  cursors: (string | undefined)[];
  starts: number[];
}

const firstPage = (filters: string, sort?: string): View => ({ filters, sort, page: 0, cursors: [undefined], starts: [0] });

type Open = { kind: "create" } | { kind: "edit"; row: Row } | { kind: "delete"; row: Row } | undefined;

/** A data grid over a collection. */
export function Table({ node }: { node: SpecNode }) {
  const host = useHost();
  const filterParams = useContext(FilterContext);
  const columns = node.columns as Column[];
  const basePath = node.basePath as string;
  const fixed: Param[] = Object.entries((node.filters ?? {}) as Record<string, unknown>).map(([name, value]) => [name, String(value)]);
  const filters = [...fixed, ...filterParams];
  const filterKey = JSON.stringify(filters);

  const [held, setView] = useState<View>(() => firstPage(filterKey));
  const view = held.filters === filterKey ? held : firstPage(filterKey, held.sort);
  const [page, setPage] = useState<CollectionPage>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [loading, setLoading] = useState(true);
  const [changes, setChanges] = useState(0);
  const [open, setOpen] = useState<Open>();
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<ErrorSpec>();
  const cursor = view.cursors[view.page];

  useEffect(() => host.onChanged(basePath, () => setChanges((count) => count + 1)), [basePath]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fetchPage(host, basePath, { limit: node.pageSize, cursor, sort: view.sort, filters }).then(
      (fetched) => {
        if (!current) return;
        setPage(fetched);
        setFailure(undefined);
        setLoading(false);
        // Remember where the next page starts, so it can be reached and replayed.
        setView((latest) => {
          const based = latest.filters === filterKey ? latest : view;
          const cursors = [...based.cursors];
          const starts = [...based.starts];
          cursors[view.page + 1] = fetched.next ?? undefined;
          starts[view.page + 1] = starts[view.page] + fetched.rows.length;
          return { ...based, cursors, starts };
        });
      },
      (error) => {
        if (!current) return;
        setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [basePath, filterKey, view.sort, view.page, cursor, changes]);

  const sortBy = (property: string) =>
    setView(firstPage(filterKey, view.sort === property ? `-${property}` : property));
  const keyOf = (row: Row) => String(row[node.rowKey]);
  const itemUrl = (row: Row) => `${basePath}/${encodeURIComponent(keyOf(row))}`;
  const rows = page?.rows ?? [];
  const start = view.starts[view.page] ?? 0;
  const actions = node.edit !== undefined || node.delete === true;
  const span = columns.length + (actions ? 1 : 0);
  const state = failure ? "error" : loading ? "loading" : rows.length === 0 ? "empty" : "idle";

  const confirmDelete = (row?: Row) => {
    setDeleteFailure(undefined);
    setOpen(row && { kind: "delete", row });
  };

  /** A refused delete stays in its dialog, as a form's failure stays in the
   *  form: the grid and its rows are as they were. */
  const remove = async (row: Row) => {
    setDeleting(true);
    setDeleteFailure(undefined);
    try {
      await send(host, itemUrl(row), { method: "DELETE" });
    } catch (error) {
      setDeleteFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      return;
    } finally {
      setDeleting(false);
    }
    setOpen(undefined);
    host.notifyChanged(basePath);
  };

  return (
    <div data-telo-part="table" data-state={state} data-style={styleAttribute(node.style)}>
      {node.create && (
        <div data-telo-part="table-toolbar">
          <button data-telo-part="table-create" type="button" onClick={() => setOpen({ kind: "create" })}>
            <Icon of={Plus} />
            New
          </button>
        </div>
      )}
      {failure ? (
        <ErrorNode error={failure} />
      ) : (
        <div data-telo-part="table-frame">
          <table data-telo-part="table-grid">
            <thead data-telo-part="table-head">
              <tr>
                {columns.map((column, index) => {
                  const sorted = column.sort === undefined ? undefined : view.sort === column.sort ? "asc" : view.sort === `-${column.sort}` ? "desc" : undefined;
                  return (
                    <th key={index} data-telo-part="table-header-cell" data-sorted={sorted} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
                      {column.sort === undefined ? (
                        column.header
                      ) : (
                        <button data-telo-part="table-sort" type="button" onClick={() => sortBy(column.sort as string)}>
                          {column.header}
                          <Icon of={sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown} />
                        </button>
                      )}
                    </th>
                  );
                })}
                {actions && <th data-telo-part="table-header-cell" />}
              </tr>
            </thead>
            <tbody data-telo-part="table-body">
              {rows.map((row) => (
                <tr key={keyOf(row)} data-telo-part="table-row" data-style={styleAttribute(ruleStyle(node.rowStyle, { row }))}>
                  {columns.map((column, index) => (
                    <td key={index} data-telo-part="table-cell" data-style={styleAttribute(ruleStyle(column.style, { row }))}>
                      {column.cell ? (
                        <RowContext.Provider value={row}>
                          <Node node={column.cell} />
                        </RowContext.Provider>
                      ) : (
                        presentValue(resolveBinding(column.value as Binding, { row }), column.present)
                      )}
                    </td>
                  ))}
                  {actions && (
                    <td data-telo-part="row-actions">
                      {node.edit && <IconButton part="row-edit" label="Edit" icon={Pencil} onClick={() => setOpen({ kind: "edit", row })} />}
                      {node.delete && <IconButton part="row-delete" label="Delete" icon={Trash2} onClick={() => confirmDelete(row)} />}
                    </td>
                  )}
                </tr>
              ))}
              {page && rows.length === 0 && (
                <tr>
                  <td data-telo-part="table-empty" colSpan={span}>
                    No rows.
                  </td>
                </tr>
              )}
              {loading && !page && (
                <tr>
                  <td data-telo-part="table-loading" colSpan={span}>
                    <Loading />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div data-telo-part="pager">
        <span data-telo-part="pager-status">
          {page ? (rows.length === 0 ? `0 of ${page.total}` : `${start + 1}–${start + rows.length} of ${page.total}`) : ""}
        </span>
        <IconButton part="pager-prev" label="Previous page" icon={ChevronLeft} disabled={view.page === 0} onClick={() => setView({ ...view, page: view.page - 1 })} />
        <IconButton part="pager-next" label="Next page" icon={ChevronRight} disabled={!page || page.next === null} onClick={() => setView({ ...view, page: view.page + 1 })} />
      </div>
      {open?.kind === "create" && (
        <Dialog title="New" onClose={() => setOpen(undefined)}>
          <Form
            node={node.create}
            target={{ method: "POST", url: basePath }}
            onCancel={() => setOpen(undefined)}
            onDone={() => {
              setOpen(undefined);
              setView(firstPage(filterKey, view.sort));
            }}
          />
        </Dialog>
      )}
      {open?.kind === "edit" && (
        <Dialog title="Edit" onClose={() => setOpen(undefined)}>
          <Form
            node={node.edit}
            target={{ method: "PUT", url: itemUrl(open.row) }}
            initial={open.row}
            onCancel={() => setOpen(undefined)}
            onDone={() => setOpen(undefined)}
          />
        </Dialog>
      )}
      {open?.kind === "delete" && (
        <ConfirmDialog
          title="Delete this row?"
          description="This cannot be undone."
          confirm="Delete"
          busy={deleting}
          failure={deleteFailure}
          onConfirm={() => remove(open.row)}
          onClose={() => confirmDelete()}
        />
      )}
    </div>
  );
}
