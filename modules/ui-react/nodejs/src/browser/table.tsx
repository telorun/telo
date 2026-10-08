import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { presentValue, resolveBinding, ruleStyle, styleAttribute, type Binding, type StyleRule } from "./bindings.js";
import { fetchPage, send, type CollectionPage, type Param } from "./collection.js";
import { Form } from "./form.js";
import { useHost, useHostStore, type HostLocation, type UnsavedGuard } from "./host.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { ErrorNode, Loading, Node, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { FilterContext, RendererContext, RowContext } from "./renderer-context.js";
import { Confirmation, Surface, type SurfaceSpec } from "./surface.js";
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

/** How a form is opened: where it appears, and what a submit and unsaved
 *  input mean to it. */
interface Opener {
  form: SpecNode;
  surface: SurfaceSpec;
  afterSubmit: "close" | "again" | "keep";
  unsaved: "confirm" | "discard";
}

/** The form that is open: the create form, or the edit form over a row's key. */
type Open = { kind: "create" } | { kind: "edit"; key: string } | undefined;

/** What a surface's form is given by whoever opened it. */
type Opened = Pick<ComponentProps<typeof Form>, "afterSubmit" | "shownAt" | "onUnsaved" | "onBusy" | "onSaved" | "onDone" | "onCancel">;

/**
 * The edit form over one record, read from the collection when it opens: a
 * row of the list may hold less than a record does, and an edit sends back
 * what the record held.
 */
function ItemForm({ node, url, opened }: { node: SpecNode; url: string; opened: Opened }) {
  const host = useHost();
  const [item, setItem] = useState<Row>();
  const [failure, setFailure] = useState<ErrorSpec>();

  useEffect(() => {
    let current = true;
    send(host, url, { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then(
        (read) => current && setItem(read as Row),
        (error) => current && setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED")),
      );
    return () => {
      current = false;
    };
  }, [url]);

  if (failure) {
    return (
      <>
        <ErrorNode error={failure} />
        <div data-telo-part="form-actions">
          <button data-telo-part="cancel" type="button" onClick={opened.onCancel}>
            Cancel
          </button>
        </div>
      </>
    );
  }
  if (!item) return <Loading />;
  return <Form node={node} target={{ method: "PUT", url }} initial={item} {...opened} />;
}

/** A data grid over a collection. */
export function Table({ node }: { node: SpecNode }) {
  const host = useHost();
  const store = useHostStore();
  const { compact } = useContext(RendererContext);
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
  // Open with no address: the surface declares none, or the row has no key to write.
  const [inMemory, setInMemory] = useState<Open>();
  const [removing, setRemoving] = useState<Row>();
  const [unsaved, setUnsaved] = useState<UnsavedGuard>();
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const [detail, setDetail] = useState<HTMLElement | null>(null);
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
  const itemUrl = (key: string) => `${basePath}/${encodeURIComponent(key)}`;
  const rows = page?.rows ?? [];
  const start = view.starts[view.page] ?? 0;
  const creates = node.create as Opener | undefined;
  const edits = node.edit as Opener | undefined;
  const actions = edits !== undefined || node.delete === true;
  const span = columns.length + (actions ? 1 : 0);
  const state = failure ? "error" : loading ? "loading" : rows.length === 0 ? "empty" : "idle";

  // The address says what is open: under a name, an empty value is the create
  // form and any other the edit form over the row with that key.
  const { path, search } = host.location;
  const createName = creates?.surface.address?.name;
  const editName = edits?.surface.address?.name;
  const editKey = editName === undefined ? undefined : openValue(search, editName);
  const addressed: Open =
    editKey !== undefined && editKey !== ""
      ? { kind: "edit", key: editKey }
      : createName !== undefined && openValue(search, createName) === ""
        ? { kind: "create" }
        : undefined;
  const open = addressed ?? inMemory;
  const opener = open?.kind === "create" ? creates : open?.kind === "edit" ? edits : undefined;
  const addressedName = addressed?.kind === "edit" ? editName : addressed ? createName : undefined;

  const finish = () => {
    if (addressedName !== undefined) store.close(addressedName);
    else setInMemory(undefined);
  };
  /** Leave the open form — to close it, or for another — asking first when it
   *  holds unsaved input, and not at all while it is being sent. */
  const leave = (then: () => void) => {
    if (busy) return;
    if (unsaved) store.ask([unsaved], then);
    else then();
  };
  const close = () => leave(finish);
  const show = (next: Exclude<Open, undefined>, name: string | undefined, value: string, from: HTMLElement) =>
    leave(() => {
      anchor.current = from;
      // A row with an empty key cannot be told from a new record in the address.
      if (name === undefined || (next.kind === "edit" && value === "")) {
        if (addressedName !== undefined) store.close(addressedName);
        setInMemory(next);
      } else {
        setInMemory(undefined);
        // One table shows one form: either name already open gives way to this one.
        store.open(name, value, [createName, editName]);
      }
    });

  const confirmDelete = (row?: Row) => {
    setDeleteFailure(undefined);
    setRemoving(row);
  };

  /** A refused delete stays in its dialog, as a form's failure stays in the
   *  form: the grid and its rows are as they were. */
  const remove = async (row: Row) => {
    setDeleting(true);
    setDeleteFailure(undefined);
    try {
      await send(host, itemUrl(keyOf(row)), { method: "DELETE" });
    } catch (error) {
      setDeleteFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      return;
    } finally {
      setDeleting(false);
    }
    setRemoving(undefined);
    host.notifyChanged(basePath);
  };

  // The address of an opening is the declared surface's, whichever is drawn.
  const surface = open && opener ? (compact && opener.surface.compact ? opener.surface.compact : opener.surface) : undefined;
  // An inline edit is drawn under its row; one whose row is not shown, and an
  // inline create, above the grid.
  const underRow = surface?.type === "inline" && open?.kind === "edit" && rows.some((row) => keyOf(row) === open.key) ? open.key : undefined;
  const above = surface?.type === "inline" && underRow === undefined;
  let drawn: ReactNode = null;
  if (open && opener && surface) {
    const value = open.kind === "edit" ? open.key : "";
    const name = open.kind === "edit" ? editName : createName;
    const stillOpen = (target: HostLocation) =>
      target.path === path && (!addressed || name === undefined || openValue(target.search, name) === value);
    const opened: Opened = {
      afterSubmit: opener.afterSubmit,
      shownAt: opener.unsaved === "confirm" ? stillOpen : undefined,
      onUnsaved: setUnsaved,
      onBusy: setBusy,
      onDone: finish,
      onCancel: close,
    };
    // One surface wherever it is drawn, so what it holds outlives a change of it.
    drawn = (
      <Surface
        key="surface"
        spec={surface}
        title={open.kind === "create" ? "New" : "Edit"}
        anchor={anchor}
        container={underRow === undefined ? undefined : detail}
        onClose={close}
      >
        {open.kind === "create" ? (
          <Form
            key="create"
            node={opener.form}
            target={{ method: "POST", url: basePath }}
            {...opened}
            onSaved={() => setView(firstPage(filterKey, view.sort))}
          />
        ) : (
          <ItemForm key={open.key} node={opener.form} url={itemUrl(open.key)} opened={opened} />
        )}
      </Surface>
    );
  }

  return (
    <div data-telo-part="table" data-state={state} data-style={styleAttribute(node.style)}>
      {creates && (
        <div data-telo-part="table-toolbar">
          <button data-telo-part="table-create" type="button" onClick={(event) => show({ kind: "create" }, createName, "", event.currentTarget)}>
            <Icon of={Plus} />
            New
          </button>
        </div>
      )}
      {above && drawn}
      <div data-telo-part="table-main">
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
                  <Fragment key={keyOf(row)}>
                    <tr data-telo-part="table-row" data-style={styleAttribute(ruleStyle(node.rowStyle, { row }))}>
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
                          {edits && <IconButton part="row-edit" label="Edit" icon={Pencil} onClick={(button) => show({ kind: "edit", key: keyOf(row) }, editName, keyOf(row), button)} />}
                          {node.delete && <IconButton part="row-delete" label="Delete" icon={Trash2} onClick={() => confirmDelete(row)} />}
                        </td>
                      )}
                    </tr>
                    {underRow === keyOf(row) && (
                      <tr>
                        <td data-telo-part="table-detail" colSpan={span} ref={setDetail} />
                      </tr>
                    )}
                  </Fragment>
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
      </div>
      {!above && drawn}
      {removing && (
        <Confirmation
          title="Delete this row?"
          description="This cannot be undone."
          confirm="Delete"
          busy={deleting}
          failure={deleteFailure}
          onConfirm={() => remove(removing)}
          onClose={() => confirmDelete()}
        />
      )}
    </div>
  );
}
