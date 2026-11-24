import { segment } from "./address-wire.js";
import { resolveBasePath, unresolvedFailure, type BasePath } from "./base-path.js";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefCallback } from "react";
import { conditionHolds, fillAttribute, ruleStyle, styleAttribute, type Binding, type StyleRule } from "./bindings.js";
import { boundFilters, send } from "./collection.js";
import { useControl } from "./effective-controls.js";
import { DetailContext, openDestination, resolveDestination, useDestinationContext, type DetailSlot, type DestinationWire } from "./destination.js";
import { useHost, useHostStore } from "./host.js";
import { IconButton } from "./icon-button.js";
import { BUILT_IN_LAYOUTS, ContractLayout } from "./layouts/contract-layout.js";
import { TableLayout } from "./layouts/table-layout.js";
import { readMode, readPositions, useGroupValues, useListingReads, type GroupValues, type ListedRecord, type ReadView } from "./listing-engine.js";
import type { ListingReads, ReadPlan, ReadPosition } from "./listing-reads.js";
import { ErrorNode, Node, type SpecNode } from "./nodes.js";
import type { RowActionSpec } from "./operation.js";
import type { OptionSourceSpec } from "./option-source.js";
import { queryRoot } from "./query-root.js";
import { heldValues, RelatedContext, useRelatedLabels, type RelatedLabels } from "./related-labels.js";
import { useEndReached } from "./record-window.js";
import { FilterContext, RendererContext, RootsContext, underMount, VisibleContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";
import { useRowActionsDisplay, type ActionsDisplay, type ActionsSetting } from "./row-actions-display.js";
import { anchorRef } from "./node-anchors.js";
import { Confirmation } from "./surface.js";
import { useSay, useText, type WireText } from "./texts.js";
import { useReloadEvery } from "./timed-reload.js";
import { errorSpec, UiError, type ErrorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

type Row = Record<string, unknown>;

/** A press a listing draws — its create button, a record's edit — as the page document carries it: where it goes, and the text naming it. */
interface PressSpec {
  to: DestinationWire;
  label: WireText;
}

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
  /** Whether the listing is the direct content of a flush split view: its layout draws no frame of its own. */
  embedded: boolean;
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
  /** A record's row actions, edit and delete: as buttons or as a menu, as `actionsArea` says. */
  actions(record: ListedRecord): ReactNode;
  /** How the actions are drawn, and what a layout gives the element holding them so the room they have is judged. */
  actionsArea: { display: ActionsDisplay; ref: RefCallback<HTMLElement> };
  /** Where the record whose edit form opens in line draws it. */
  detail?: { key: string; ref: (element: HTMLElement | null) => void };
  /** Run the listing's create press with the property values the place proposes for the record, where it has one. */
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
 * related records, invalidation, a timed reload, openers, row actions, delete
 * and the empty state are the listing's, whatever the layout. A templated
 * `basePath` resolves over the roots in scope; one that does not resolve reads
 * nothing and draws its failure.
 */
export function Listing({ node, embedded = false }: { node: SpecNode; embedded?: boolean }) {
  const Icon = useControl("Icon");
  const host = useHost();
  const say = useSay();
  const store = useHostStore();
  const { compact, prefix } = useContext(RendererContext);
  const filterParams = useContext(FilterContext);
  const visible = useContext(VisibleContext);
  const roots = useContext(RootsContext);
  const recordKey = node.key as string;
  const relations = node.relations as Record<string, OptionSourceSpec>;
  const spec = (compact && node.compact ? node.compact : node.layout) as LayoutSpec;
  const plan = spec.reads;
  const mode = readMode(spec.type, plan, node.paging);
  const query = useMemo(() => queryRoot(node.query as Record<string, JsonSchema>, host.location.search), [node.query, host.location.search]);
  const rowRoots = useMemo(() => ({ ...roots, query }), [roots, query]);
  const base = resolveBasePath(node.basePath as BasePath, rowRoots, "'listing' basePath");
  const basePath = base.ok ? base.address : undefined;
  const unresolved = unresolvedFailure(base);
  // Only drawn once the path resolves: nothing below is reached with none.
  const collectionPath = basePath ?? "";
  const keyOf = (row: Row) => String(row[recordKey]);

  const sorting = node.sort as { sortable: string[]; initial: string | null };
  const [chosen, setSort] = useState<string>();
  // The order the listing starts in is read until the viewer chooses another.
  const sort = chosen ?? sorting.initial ?? undefined;
  const [period, setPeriod] = useState<{ from: string; to: string }>();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [changes, setChanges] = useState(0);
  // While a filter the listing reads holds nothing, nothing is read.
  const fixed = boundFilters(node.filters as Record<string, Binding> | undefined, rowRoots);
  const listing: ListingReads | undefined =
    fixed && basePath !== undefined
      ? { basePath, pageSize: node.pageSize, filters: fixed, bar: filterParams, ...(sort !== undefined ? { sort } : {}) }
      : undefined;
  const groups = useGroupValues(host, prefix, listing, plan, relations, rowRoots, visible, changes);
  const positions: ReadPosition[] = readPositions(plan, groups, period, expanded);
  const reads = useListingReads({ host, prefix, listing, plan, mode, positions, keyOf, visible });

  // Matched by the path as it resolved: a write under another record's path reloads another listing.
  useEffect(
    () =>
      basePath === undefined
        ? undefined
        : host.onChanged(basePath, () => {
            reads.reload();
            setChanges((count) => count + 1);
          }),
    [basePath, reads.reload],
  );
  useEffect(
    () => (basePath === undefined ? undefined : store.onWritten(basePath, (row) => Object.hasOwn(row, recordKey) && reads.patch(row))),
    [basePath, recordKey, reads.patch],
  );
  // Every read, the values grouped by and the facet requests over the source, on the timer.
  useReloadEvery(
    node.reloadEvery as number | undefined,
    visible && listing !== undefined,
    () => reads.reads.some((read) => read.loading) || groups?.loading === true,
    () => {
      reads.reload();
      setChanges((count) => count + 1);
      if (basePath !== undefined) store.reread(basePath);
    },
  );

  // Every key of every record answered in this turn, by the relation that labels it.
  const records = reads.reads.flatMap((read) => read.records);
  const wanted: Record<string, unknown[]> = {};
  for (const property of Object.keys(relations)) wanted[property] = records.flatMap((record) => heldValues(record.row[property]));
  if (plan.groups?.relation !== undefined && groups) {
    (wanted[plan.groups.relation] ??= []).push(...groups.values.filter((value) => !value.option).map((value) => value.value));
  }
  const labels = useRelatedLabels(relations, wanted, rowRoots);

  const text = useText();
  const destinations = useDestinationContext();
  const [removing, setRemoving] = useState<ListedRecord>();
  // The record an inline surface is drawn under, and who is told where its place is.
  const [detailing, setDetailing] = useState<{ key: string; report: (element: HTMLElement | null) => void }>();
  const reported = useRef(detailing);
  reported.current = detailing;
  const detailRef = useCallback((element: HTMLElement | null) => reported.current?.report(element), []);
  const slotFor = useCallback(
    (row: Row): DetailSlot => ({
      show: (report) => {
        setDetailing({ key: String(row[recordKey]), report });
        return () => setDetailing(undefined);
      },
    }),
    [recordKey],
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<ErrorSpec>();
  // The delete in flight. Read on the press itself, which can arrive before
  // the disabled buttons are drawn.
  const writing = useRef(false);
  // A record an action or a move answered with is drawn from that answer.
  const rowActions = useRowActions(node.rowActions as RowActionSpec[], rowRoots, (result, key) => succeeded(result, key));
  const succeeded = (result: Record<string, unknown> | undefined, key: string) => {
    if (basePath === undefined) return;
    if (result && Object.hasOwn(result, recordKey) && String(result[recordKey]) === key) store.written(basePath, result);
    host.notifyChanged(basePath);
  };
  // The layout's move, run as a row action over `row` and `to`.
  const moves = useRowActions(spec.move ? [spec.move as RowActionSpec] : [], rowRoots, succeeded);
  const itemPath = (key: string) => `${collectionPath}/${segment(key)}`;
  const itemUrl = (key: string) => underMount(prefix, itemPath(key));
  const creates = (node.create ?? undefined) as PressSpec | undefined;
  const edits = (node.edit ?? undefined) as PressSpec | undefined;
  const hasActions = (node.rowActions as RowActionSpec[]).length > 0 || edits !== undefined || node.delete === true;
  const shownActions = useRowActionsDisplay(
    node.rowActionsDisplay as ActionsSetting,
    `${records.map((record) => record.key).join("\u0000")}|${(node.rowActions as RowActionSpec[]).length}|${edits ? 1 : 0}|${node.delete ? 1 : 0}`,
  );

  /** Go where a press of the listing leads: over the roots in scope — and the record's, where it is one's. */
  const press = (spec: PressSpec, roots: Readonly<Record<string, unknown>>, opener: HTMLElement | null, detail?: DetailSlot) => {
    const destination = resolveDestination(spec.to, roots, "'press' to");
    if (destination === undefined) return;
    openDestination(destination.to, { ...destinations, address: destination.address }, { naming: text(spec.label, undefined, roots), opener, detail });
  };
  const edit = (record: ListedRecord, button: HTMLElement | null) => edits && press(edits, { ...rowRoots, row: record.row }, button, slotFor(record.row));

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
      // A record changed since it was read: the listing reads it again.
      if (error instanceof UiError && error.status === 412) host.notifyChanged(collectionPath);
      return;
    } finally {
      writing.current = false;
      setDeleting(false);
    }
    setRemoving(undefined);
    host.notifyChanged(collectionPath);
    host.notifyChanged(itemPath(record.key));
  };

  // A record's answers last while its key is drawn.
  const shownKeys = reads.reads.every((read) => read.answered) ? records.map((record) => record.key).join("\u0000") : undefined;
  useEffect(() => {
    if (shownKeys !== undefined) rowActions.retain(new Set(shownKeys === "" ? [] : shownKeys.split("\u0000")));
  }, [shownKeys]);

  const failure = reads.reads.find((read) => read.failure)?.failure;
  const answered = reads.reads.length > 0 && reads.reads.every((read) => read.answered);
  const state = failure ? "error" : !answered && reads.reads.some((read) => read.loading) ? "loading" : records.length === 0 ? "empty" : "idle";
  const drawing: ListingDrawing = {
    reads: reads.reads,
    embedded,
    ...(groups ? { groups } : {}),
    ...(period ? { period } : {}),
    showPeriod: (next) => setPeriod((held) => (held?.from === next.from && held.to === next.to ? held : next)),
    expanded,
    expand: (key, opening) => setExpanded((held) => (opening ? (held.includes(key) ? held : [...held, key]) : held.filter((each) => each !== key))),
    sort: {
      ...(sort !== undefined ? { value: sort } : {}),
      sortable: sorting.sortable,
      sortBy: (property) => setSort(sort === property ? `-${property}` : property),
      set: setSort,
    },
    windowed: mode === "more",
    state,
    empty: <Node node={node.empty} />,
    rowStyle: (row) => styleAttribute(ruleStyle(node.rowStyle as StyleRule | undefined, { row })),
    hasActions,
    actionsArea: { display: shownActions.display, ref: shownActions.area },
    actions: (record) =>
      shownActions.display === "menu" ? (
        rowActions.menuCell(record.row, record.key, deleting, [
          ...(edits ? [{ key: "edit", label: text(edits.label, undefined, { ...rowRoots, row: record.row }), run: (button: HTMLElement) => edit(record, button) }] : []),
          ...(node.delete
            ? [{ key: "delete", label: say("delete"), disabled: rowActions.busy(record.key), run: () => confirmDelete(record) }]
            : []),
        ])
      ) : (
        <>
          {rowActions.cell(record.row, record.key, deleting)}
          {edits && <IconButton part="row-edit" label={text(edits.label, undefined, { ...rowRoots, row: record.row })} icon="edit" onClick={(button) => edit(record, button)} />}
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
    ...(detailing !== undefined ? { detail: { key: detailing.key, ref: detailRef } } : {}),
    ...(creates ? { create: (values: Row) => press(creates, { ...rowRoots, values }, null) } : {}),
    move: (record, to) => moves.press(0, record.row, record.key, { to }),
    movable: (record) => spec.move !== undefined && !moves.busy(record.key) && conditionHolds((spec.move as RowActionSpec).enabled, { ...rowRoots, row: record.row }),
    moveFailure: (record) => moves.failure(0, record.key),
    labels,
  };

  const Layout = layoutOf(spec.type);
  // A plan with no dimension is one read, and its paging is the listing's own.
  const single = plan.groups === undefined && plan.span === undefined && plan.parent === undefined ? reads.reads[0] : undefined;
  if (unresolved) {
    return (
      <div ref={anchorRef(node)} data-telo-part="listing" data-state="error" data-fill={fillAttribute(node)} data-style={styleAttribute(node.style)}>
        <ErrorNode error={unresolved} />
      </div>
    );
  }
  const pager = single?.pager;
  const showCount = (node.show as { count: boolean }).count;
  const rows = single?.records.length ?? 0;
  return (
    <div ref={anchorRef(node)} data-telo-part="listing" data-state={state} data-fill={fillAttribute(node)} data-style={styleAttribute(node.style)}>
      {creates && (
        <div data-telo-part="listing-toolbar">
          <button data-telo-part="listing-create" type="button" onClick={(event) => press(creates, { ...rowRoots, values: {} }, event.currentTarget)}>
            <Icon name="add" />
            {text(creates.label, undefined, { ...rowRoots, values: {} })}
          </button>
        </div>
      )}
      <div data-telo-part="listing-main" ref={shownActions.container}>
        {single?.failure && !single.kept ? (
          <ErrorNode error={single.failure} />
        ) : !Layout ? (
          <ErrorNode error={{ type: "error", code: "ERR_UI_NODE_INVALID", message: `This renderer does not draw a '${spec.type}' layout.` }} />
        ) : (
          <RelatedContext.Provider value={{ relations, labels }}>
            <DetailContext.Provider value={slotFor}>
              <Layout spec={spec} node={node} drawing={drawing} />
            </DetailContext.Provider>
          </RelatedContext.Provider>
        )}
        {single?.failure && single.kept && <ErrorNode error={single.failure} />}
        {Object.values(labels.failures).map((each, index) => (
          <ErrorNode key={index} error={each} />
        ))}
        {single && (
          <div data-telo-part="pager">
            {showCount && (
              <span data-telo-part="pager-status">
                {single.total === undefined
                  ? ""
                  : rows === 0
                    ? say("pagerEmpty", { total: single.total })
                    : say("pagerRange", { first: (pager?.start ?? 0) + 1, last: (pager?.start ?? 0) + rows, total: single.total })}
              </span>
            )}
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
