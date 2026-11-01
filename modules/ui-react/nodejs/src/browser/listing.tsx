import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { conditionHolds, ruleStyle, styleAttribute, type Binding, type StyleRule } from "./bindings.js";
import { boundFilters, send } from "./collection.js";
import { useControl } from "./effective-controls.js";
import { Form } from "./form.js";
import { useHost, useHostStore, type HostLocation, type UnsavedGuard } from "./host.js";
import { IconButton } from "./icon-button.js";
import { BUILT_IN_LAYOUTS, ContractLayout } from "./layouts/contract-layout.js";
import { TableLayout } from "./layouts/table-layout.js";
import { readMode, readPositions, useGroupValues, useListingReads, type GroupValues, type ListedRecord, type ReadView } from "./listing-engine.js";
import type { ListingReads, ReadPlan, ReadPosition } from "./listing-reads.js";
import { ErrorNode, Loading, Node, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import type { RowActionSpec } from "./operation.js";
import type { OptionSourceSpec } from "./option-source.js";
import { queryRoot } from "./query-root.js";
import { heldValues, RelatedContext, useRelatedLabels, type RelatedLabels } from "./related-labels.js";
import { useEndReached } from "./record-window.js";
import { FilterContext, RendererContext, RootsContext, underMount, VisibleContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";
import { Confirmation, Surface, type SurfaceSpec } from "./surface.js";
import { useSay } from "./texts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

type Row = Record<string, unknown>;

/** How a form is opened: where it appears, and what a submit and unsaved
 *  input mean to it. */
interface Opener {
  form: SpecNode;
  surface: SurfaceSpec;
  afterSubmit: "close" | "again" | "keep";
  unsaved: "confirm" | "discard";
}

/** The form that is open: the create form, or the edit form over a record's key. */
type Open = { kind: "create" } | { kind: "edit"; key: string } | undefined;

/** What a surface's form is given by whoever opened it. */
type Opened = Pick<ComponentProps<typeof Form>, "afterSubmit" | "shownAt" | "onUnsaved" | "onBusy" | "onSaved" | "onDone" | "onCancel">;

/** A layout spec as the page document carries it: its `type`, its own keys and its read plan. */
export type LayoutSpec = { type: string; reads: ReadPlan } & Record<string, any>;

/** The listing's state and intents, as a layout draws them. Everything but
 *  the drawing is the listing's, whatever the layout. */
export interface ListingDrawing {
  /** The reads of the plan's product, in order. */
  reads: ReadView[];
  /** Under a grouping, the values a group is read for. */
  groups?: GroupValues;
  /** The period a spanned plan reads, once the layout has named one. */
  period?: { from: string; to: string };
  showPeriod(period: { from: string; to: string }): void;
  /** The records whose children a tree plan reads. */
  expanded: readonly string[];
  expand(key: string, open: boolean): void;
  /** The viewer's sort over the properties the collection sorts by: by a property, ascending then descending, or set outright. */
  sort: { value?: string; sortable: readonly string[]; sortBy(property: string): void; set(sort: string): void };
  /** Whether the records are drawn page by page while in view: under `more` and `scroll`. */
  windowed: boolean;
  /** `loading` before any read answered, `error` when one failed, `empty` when none holds a record. */
  state: "loading" | "error" | "empty" | "idle";
  /** The node drawn where the records would be when the reads answer none. */
  empty: ReactNode;
  /** The style names a record's element carries. */
  rowStyle(row: Row): string | undefined;
  /** Whether each record offers row actions, edit or delete. */
  hasActions: boolean;
  /** A record's row actions, edit and delete. */
  actions(record: ListedRecord): ReactNode;
  /** Where the record whose edit form opens in line draws it. */
  detail?: { key: string; ref: (element: HTMLElement | null) => void };
  /** Open a record's edit form, where the listing edits. */
  open?(key: string): void;
  /** Open the create form holding these values, where the listing creates. */
  create?(values: Record<string, unknown>): void;
  /** Run the layout's move for a record, `to` the record as the gesture leaves it. */
  move(record: ListedRecord, to: Row): void;
  /** Whether the layout's move may run for a record now. */
  movable(record: ListedRecord): boolean;
  /** What a record's last move failed with; `null` when none did. */
  moveFailure(record: ListedRecord): ReactNode;
  /** The label a related record is shown with. */
  labels: RelatedLabels;
}

export interface LayoutProps {
  spec: LayoutSpec;
  /** The listing node: its schema, key, relations and paging. */
  node: SpecNode;
  drawing: ListingDrawing;
}

/** What draws a layout of the spec's `type`: the table itself, every other this renderer draws through the layout contract. */
const layoutOf = (type: string): ComponentType<LayoutProps> | undefined =>
  type === "table" ? TableLayout : type === "component" || Object.hasOwn(BUILT_IN_LAYOUTS, type) ? ContractLayout : undefined;

/**
 * The edit form over one record, read from the collection when it opens: a
 * record shown may hold less than the record does, and an edit sends back
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

/** The control loading a read's next page: pressed, or under `scroll` when it comes into view. */
export function LoadMore({ read, scroll }: { read: ReadView; scroll: boolean }) {
  const say = useSay();
  const end = useEndReached(scroll, read.hasMore && !read.loading && read.failure === undefined, read.loadMore);
  if (!read.hasMore) return null;
  return (
    <button data-telo-part="load-more" type="button" ref={end} aria-busy={read.loading ? true : undefined} onClick={read.loadMore}>
      {say("loadMore")}
    </button>
  );
}

/**
 * Records of a collection, read under the listing's read plan and drawn by its
 * layout — by `compact` below the application's breakpoint, the listing's
 * state kept across the swap. Reading, paging, the viewer's sort, labels of
 * related records, invalidation, openers, row actions, delete and the empty
 * state are the listing's, whatever the layout.
 */
export function Listing({ node }: { node: SpecNode }) {
  const Icon = useControl("Icon");
  const host = useHost();
  const say = useSay();
  const store = useHostStore();
  const { compact, prefix } = useContext(RendererContext);
  const filterParams = useContext(FilterContext);
  const visible = useContext(VisibleContext);
  const roots = useContext(RootsContext);
  const basePath = node.basePath as string;
  const collectionAt = underMount(prefix, basePath);
  const recordKey = node.key as string;
  const relations = node.relations as Record<string, OptionSourceSpec>;
  const spec = (compact && node.compact ? node.compact : node.layout) as LayoutSpec;
  const plan = spec.reads;
  const mode = readMode(spec.type, plan, node.paging);
  const query = useMemo(() => queryRoot(node.query as Record<string, JsonSchema>, host.location.search), [node.query, host.location.search]);
  const rowRoots = useMemo(() => ({ ...roots, query }), [roots, query]);
  const keyOf = (row: Row) => String(row[recordKey]);

  const [sort, setSort] = useState<string>();
  const [period, setPeriod] = useState<{ from: string; to: string }>();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [changes, setChanges] = useState(0);
  // While a filter the listing reads holds nothing, nothing is read.
  const fixed = boundFilters(node.filters as Record<string, Binding> | undefined, rowRoots);
  const listing: ListingReads | undefined = fixed && {
    basePath,
    pageSize: node.pageSize,
    filters: fixed,
    bar: filterParams,
    ...(sort !== undefined ? { sort } : {}),
  };
  const groups = useGroupValues(host, prefix, listing, plan, relations, visible, changes);
  const positions: ReadPosition[] = readPositions(plan, groups, period, expanded);
  const reads = useListingReads({ host, prefix, listing, plan, mode, positions, keyOf, visible });

  useEffect(
    () =>
      host.onChanged(basePath, () => {
        reads.reload();
        setChanges((count) => count + 1);
      }),
    [basePath, reads.reload],
  );
  useEffect(() => store.onWritten(basePath, (row) => Object.hasOwn(row, recordKey) && reads.patch(row)), [basePath, recordKey, reads.patch]);

  // Every key of every record answered in this turn, by the relation that labels it.
  const records = reads.reads.flatMap((read) => read.records);
  const wanted: Record<string, unknown[]> = {};
  for (const property of Object.keys(relations)) wanted[property] = records.flatMap((record) => heldValues(record.row[property]));
  if (plan.groups?.relation !== undefined && groups) {
    (wanted[plan.groups.relation] ??= []).push(...groups.values.filter((value) => !value.option).map((value) => value.value));
  }
  const labels = useRelatedLabels(relations, wanted, rowRoots);

  // Open with no address: the surface declares none, or the record has no key to write.
  const [inMemory, setInMemory] = useState<Open>();
  const [removing, setRemoving] = useState<ListedRecord>();
  const [unsaved, setUnsaved] = useState<UnsavedGuard>();
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const [detail, setDetail] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<ErrorSpec>();
  // The delete in flight. Read on the press itself, which can arrive before
  // the disabled buttons are drawn.
  const writing = useRef(false);
  // A record an action or a move answered with is drawn from that answer.
  const rowActions = useRowActions(node.rowActions as RowActionSpec[], rowRoots, (result, key) => succeeded(result, key));
  const succeeded = (result: Record<string, unknown> | undefined, key: string) => {
    if (result && Object.hasOwn(result, recordKey) && String(result[recordKey]) === key) store.written(basePath, result);
    host.notifyChanged(basePath);
  };
  // The layout's move, run as a row action over `row` and `to`.
  const moves = useRowActions(spec.move ? [spec.move as RowActionSpec] : [], rowRoots, succeeded);
  // What a create opened from the layout starts with: a column's value, a day.
  const [createValues, setCreateValues] = useState<Row>();
  const itemUrl = (key: string) => `${collectionAt}/${encodeURIComponent(key)}`;
  const creates = node.create as Opener | undefined;
  const edits = node.edit as Opener | undefined;
  const hasActions = (node.rowActions as RowActionSpec[]).length > 0 || edits !== undefined || node.delete === true;

  // The address says what is open: under a name, an empty value is the create
  // form and any other the edit form over the record with that key.
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
      // A record with an empty key cannot be told from a new record in the address.
      if (name === undefined || (next.kind === "edit" && value === "")) {
        if (addressedName !== undefined) store.close(addressedName);
        setInMemory(next);
      } else {
        setInMemory(undefined);
        // One listing shows one form: either name already open gives way to this one.
        store.open(name, value, [createName, editName]);
      }
    });

  const confirmDelete = (record?: ListedRecord) => {
    setDeleteFailure(undefined);
    setRemoving(record);
  };

  /** A refused delete stays in its dialog, as a form's failure stays in the
   *  form: the records are as they were. */
  const remove = async (record: ListedRecord) => {
    if (writing.current || rowActions.busy(record.key)) return;
    writing.current = true;
    setDeleting(true);
    setDeleteFailure(undefined);
    try {
      await send(host, itemUrl(record.key), { method: "DELETE" });
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

  // A record's answers last while its key is drawn.
  const shownKeys = reads.reads.every((read) => read.answered) ? records.map((record) => record.key).join("\u0000") : undefined;
  useEffect(() => {
    if (shownKeys !== undefined) rowActions.retain(new Set(shownKeys === "" ? [] : shownKeys.split("\u0000")));
  }, [shownKeys]);

  // The address of an opening is the declared surface's, whichever is drawn.
  const surface = open && opener ? (compact && opener.surface.compact ? opener.surface.compact : opener.surface) : undefined;
  // An inline edit is drawn under its record; one whose record is not drawn,
  // and an inline create, above the records.
  const underRecord = surface?.type === "inline" && open?.kind === "edit" && records.some((record) => record.key === open.key) ? open.key : undefined;
  const above = surface?.type === "inline" && underRecord === undefined;
  let drawn: ReactNode = null;
  if (open && opener && surface) {
    const value = open.kind === "edit" ? open.key : "";
    const name = open.kind === "edit" ? editName : createName;
    const stillOpen = (target: HostLocation) => target.path === path && (!addressed || name === undefined || openValue(target.search, name) === value);
    const opened: Opened = {
      afterSubmit: opener.afterSubmit,
      shownAt: opener.unsaved === "confirm" ? stillOpen : undefined,
      onUnsaved: setUnsaved,
      onBusy: setBusy,
      onDone: finish,
      onCancel: close,
    };
    // One surface wherever it is drawn, so what it holds outlives a change of
    // it — and of the layout drawing the records.
    drawn = (
      <Surface
        key="surface"
        spec={surface}
        title={say(open.kind === "create" ? "newRecord" : "edit")}
        anchor={anchor}
        container={underRecord === undefined ? undefined : detail}
        onClose={close}
      >
        {open.kind === "create" ? (
          <Form key={`create${JSON.stringify(createValues ?? {})}`} node={opener.form} target={{ method: "POST", url: collectionAt }} initial={createValues} {...opened} />
        ) : (
          <ItemForm key={open.key} node={opener.form} url={itemUrl(open.key)} opened={opened} />
        )}
      </Surface>
    );
  }

  const failure = reads.reads.find((read) => read.failure)?.failure;
  const answered = reads.reads.length > 0 && reads.reads.every((read) => read.answered);
  const state = failure ? "error" : !answered && reads.reads.some((read) => read.loading) ? "loading" : records.length === 0 ? "empty" : "idle";
  const drawing: ListingDrawing = {
    reads: reads.reads,
    ...(groups ? { groups } : {}),
    ...(period ? { period } : {}),
    showPeriod: (next) => setPeriod((held) => (held?.from === next.from && held.to === next.to ? held : next)),
    expanded,
    expand: (key, opening) => setExpanded((held) => (opening ? (held.includes(key) ? held : [...held, key]) : held.filter((each) => each !== key))),
    sort: {
      ...(sort !== undefined ? { value: sort } : {}),
      sortable: node.sort as string[],
      sortBy: (property) => setSort((held) => (held === property ? `-${property}` : property)),
      set: setSort,
    },
    windowed: mode === "more",
    state,
    empty: <Node node={node.empty} />,
    rowStyle: (row) => styleAttribute(ruleStyle(node.rowStyle as StyleRule | undefined, { row })),
    hasActions,
    actions: (record) => (
      <>
        {rowActions.cell(record.row, record.key, deleting)}
        {edits && <IconButton part="row-edit" label={say("edit")} icon="edit" onClick={(button) => show({ kind: "edit", key: record.key }, editName, record.key, button)} />}
        {node.delete && (
          <IconButton
            part="row-delete"
            label={say("delete")}
            icon="delete"
            disabled={rowActions.busy(record.key)}
            onClick={() => rowActions.busy(record.key) || confirmDelete(record)}
          />
        )}
      </>
    ),
    ...(underRecord !== undefined ? { detail: { key: underRecord, ref: setDetail } } : {}),
    ...(edits ? { open: (key: string) => show({ kind: "edit", key }, editName, key, document.activeElement as HTMLElement) } : {}),
    ...(creates
      ? {
          create: (values: Row) => {
            setCreateValues(values);
            show({ kind: "create" }, createName, "", document.activeElement as HTMLElement);
          },
        }
      : {}),
    move: (record, to) => moves.press(0, record.row, record.key, { to }),
    movable: (record) => spec.move !== undefined && !moves.busy(record.key) && conditionHolds((spec.move as RowActionSpec).enabled, { ...rowRoots, row: record.row }),
    moveFailure: (record) => moves.failure(0, record.key),
    labels,
  };

  const Layout = layoutOf(spec.type);
  // A plan with no dimension is one read, and its paging is the listing's own.
  const single = plan.groups === undefined && plan.span === undefined && plan.parent === undefined ? reads.reads[0] : undefined;
  const pager = single?.pager;
  const rows = single?.records.length ?? 0;
  return (
    <div data-telo-part="listing" data-state={state} data-style={styleAttribute(node.style)}>
      {creates && (
        <div data-telo-part="listing-toolbar">
          <button
            data-telo-part="listing-create"
            type="button"
            onClick={(event) => {
              setCreateValues(undefined);
              show({ kind: "create" }, createName, "", event.currentTarget);
            }}
          >
            <Icon name="add" />
            {say("newRecord")}
          </button>
        </div>
      )}
      {above && drawn}
      <div data-telo-part="listing-main">
        {single?.failure ? (
          <ErrorNode error={single.failure} />
        ) : !Layout ? (
          <ErrorNode error={{ type: "error", code: "ERR_UI_NODE_INVALID", message: `This renderer does not draw a '${spec.type}' layout.` }} />
        ) : (
          <RelatedContext.Provider value={{ relations, labels }}>
            <Layout spec={spec} node={node} drawing={drawing} />
          </RelatedContext.Provider>
        )}
        {Object.values(labels.failures).map((each, index) => (
          <ErrorNode key={index} error={each} />
        ))}
        {single && (
          <div data-telo-part="pager">
            <span data-telo-part="pager-status">
              {single.total === undefined
                ? ""
                : rows === 0
                  ? say("pagerEmpty", { total: single.total })
                  : say("pagerRange", { first: (pager?.start ?? 0) + 1, last: (pager?.start ?? 0) + rows, total: single.total })}
            </span>
            {pager ? (
              <>
                <IconButton part="pager-prev" label={say("previousPage")} icon="previous" disabled={!pager.hasPrevious} onClick={pager.previous} />
                <IconButton part="pager-next" label={say("nextPage")} icon="next" disabled={!pager.hasNext} onClick={pager.next} />
              </>
            ) : (
              // A layout of the contract draws its own "Load more"; the table's is the listing's.
              spec.type === "table" && <LoadMore read={single} scroll={node.paging === "scroll"} />
            )}
          </div>
        )}
      </div>
      {!above && drawn}
      {rowActions.dialog}
      {moves.dialog}
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
