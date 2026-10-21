import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { resolveBinding, ruleStyle, styleAttribute, type Binding, type StyleRule } from "./bindings.js";
import { boundFilters, fetchPage, send, type CollectionPage } from "./collection.js";
import { Form } from "./form.js";
import { useHost, useHostStore, type HostLocation, type UnsavedGuard } from "./host.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { ErrorNode, Loading, Node, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { FilterContext, RendererContext, RootsContext, RowContext, VisibleContext } from "./renderer-context.js";
import type { RowActionSpec } from "./operation.js";
import { queryRoot } from "./query-root.js";
import { useRowActions } from "./row-actions.js";
import { Confirmation, Surface, type SurfaceSpec } from "./surface.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";
import { useSay, useText, type ValueLabel, type WireText } from "./texts.js";
import { Presented } from "./value-cell.js";

interface Column {
  header: WireText;
  value?: Binding;
  sort?: string;
  present?: { type?: unknown; format?: unknown };
  labels?: ValueLabel[];
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
  const say = useSay();
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
            {say("cancel")}
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
  const say = useSay();
  const text = useText();
  const store = useHostStore();
  const { compact } = useContext(RendererContext);
  const filterParams = useContext(FilterContext);
  const visible = useContext(VisibleContext);
  const roots = useContext(RootsContext);
  // What the shown page was read for: hidden, the table reads nothing, and on
  // show it reads once if anything changed meanwhile.
  const loadedFor = useRef<string>(undefined);
  // Only the latest read is drawn; one already in flight when the table is
  // hidden completes into the kept state.
  const latestRead = useRef(0);
  const columns = node.columns as Column[];
  const basePath = node.basePath as string;
  // A row action reads the row, and the query parameters the table declares;
  // the source's own filters read the same roots.
  const query = useMemo(() => queryRoot(node.query as Record<string, JsonSchema>, host.location.search), [node.query, host.location.search]);
  const rowRoots = useMemo(() => ({ ...roots, query }), [roots, query]);
  // While a filter the source reads holds nothing, nothing is read.
  const fixed = boundFilters(node.filters as Record<string, Binding> | undefined, rowRoots);
  const filters = [...(fixed ?? []), ...filterParams];
  const filterKey = JSON.stringify(fixed === undefined ? null : filters);

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
  // The delete in flight. Read on the press itself, which can arrive before
  // the disabled buttons are drawn.
  const writing = useRef(false);
  const rowActions = useRowActions(node.rowActions as RowActionSpec[], rowRoots, () => host.notifyChanged(basePath));
  const cursor = view.cursors[view.page];

  useEffect(() => host.onChanged(basePath, () => setChanges((count) => count + 1)), [basePath]);

  useEffect(() => {
    const wanted = JSON.stringify([basePath, filterKey, view.sort, view.page, cursor, changes]);
    if (!visible || loadedFor.current === wanted) return;
    loadedFor.current = wanted;
    const read = ++latestRead.current;
    if (fixed === undefined) {
      setPage({ rows: [], total: 0, next: null });
      setFailure(undefined);
      setLoading(false);
      return;
    }
    const current = () => read === latestRead.current;
    setLoading(true);
    fetchPage(host, basePath, { limit: node.pageSize, cursor, sort: view.sort, filters }).then(
      (fetched) => {
        if (!current()) return;
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
        if (!current()) return;
        setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
        setLoading(false);
      },
    );
  }, [basePath, filterKey, view.sort, view.page, cursor, changes, visible]);

  const sortBy = (property: string) =>
    setView(firstPage(filterKey, view.sort === property ? `-${property}` : property));
  const keyOf = (row: Row) => String(row[node.rowKey]);
  const itemUrl = (key: string) => `${basePath}/${encodeURIComponent(key)}`;
  const rows = page?.rows ?? [];
  const start = view.starts[view.page] ?? 0;
  const creates = node.create as Opener | undefined;
  const edits = node.edit as Opener | undefined;
  const actions = (node.rowActions as RowActionSpec[]).length > 0 || edits !== undefined || node.delete === true;
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
    if (writing.current || rowActions.busy(keyOf(row))) return;
    writing.current = true;
    setDeleting(true);
    setDeleteFailure(undefined);
    try {
      await send(host, itemUrl(keyOf(row)), { method: "DELETE" });
    } catch (error) {
      setDeleteFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      return;
    } finally {
      writing.current = false;
      setDeleting(false);
    }
    setRemoving(undefined);
    host.notifyChanged(basePath);
  };

  // A row's answers last while its key is on the shown page.
  const shownKeys = page ? page.rows.map((row) => String(row[node.rowKey])).join("\u0000") : undefined;
  useEffect(() => {
    if (shownKeys !== undefined) rowActions.retain(new Set(shownKeys === "" ? [] : shownKeys.split("\u0000")));
  }, [shownKeys]);

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
        title={say(open.kind === "create" ? "newRecord" : "edit")}
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
            {say("newRecord")}
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
                          text(column.header)
                        ) : (
                          <button data-telo-part="table-sort" type="button" onClick={() => sortBy(column.sort as string)}>
                            {text(column.header)}
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
                            <Presented value={resolveBinding(column.value as Binding, { row })} present={column.present} labels={column.labels} />
                          )}
                        </td>
                      ))}
                      {actions && (
                        <td data-telo-part="row-actions">
                          {rowActions.cell(row, keyOf(row), deleting)}
                          {edits && <IconButton part="row-edit" label={say("edit")} icon={Pencil} onClick={(button) => show({ kind: "edit", key: keyOf(row) }, editName, keyOf(row), button)} />}
                          {node.delete && <IconButton part="row-delete" label={say("delete")} icon={Trash2} disabled={rowActions.busy(keyOf(row))} onClick={() => rowActions.busy(keyOf(row)) || confirmDelete(row)} />}
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
                      {say("noRows")}
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
            {page
              ? rows.length === 0
                ? say("pagerEmpty", { total: page.total })
                : say("pagerRange", { first: start + 1, last: start + rows.length, total: page.total })
              : ""}
          </span>
          <IconButton part="pager-prev" label={say("previousPage")} icon={ChevronLeft} disabled={view.page === 0} onClick={() => setView({ ...view, page: view.page - 1 })} />
          <IconButton part="pager-next" label={say("nextPage")} icon={ChevronRight} disabled={!page || page.next === null} onClick={() => setView({ ...view, page: view.page + 1 })} />
        </div>
      </div>
      {!above && drawn}
      {rowActions.dialog}
      {removing && (
        <Confirmation
          title={say("deleteRowQuestion")}
          description={say("deleteRowDetail")}
          confirm={say("delete")}
          cancel={say("cancel")}
          busy={deleting}
          failure={deleteFailure}
          onConfirm={() => remove(removing)}
          onClose={() => confirmDelete()}
        />
      )}
    </div>
  );
}
