import { useContext, type ComponentType, type ReactNode } from "react";
import type { LayoutGroup, LayoutLevel, LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { readBinding, type Binding } from "../bindings.js";
import { LoadedComponent } from "../component.js";
import type { LayoutProps as DrawnLayout } from "../listing.js";
import type { ListedRecord, ReadView } from "../listing-engine.js";
import { Node, type SpecNode } from "../nodes.js";
import { optionOf, type OptionSourceSpec } from "../option-source.js";
import { heldValues } from "../related-labels.js";
import { RendererContext, RootsContext, RowContext } from "../renderer-context.js";
import { labelFor, useSay, useText, type WireText } from "../texts.js";
import { BoardLayout } from "./board-layout.js";
import { CalendarLayout } from "./calendar-layout.js";
import { CardsLayout } from "./cards-layout.js";
import { ListLayout } from "./list-layout.js";
import { TimelineLayout } from "./timeline-layout.js";
import { TreeLayout } from "./tree-layout.js";

/** The built-in layouts of `ui_react_layouts-1`, by the spec's `type`. */
export const BUILT_IN_LAYOUTS: Readonly<Record<string, ComponentType<LayoutProps>>> = {
  list: ListLayout,
  cards: CardsLayout,
  board: BoardLayout,
  calendar: CalendarLayout,
  timeline: TimelineLayout,
  tree: TreeLayout,
};

/** A layout's per-record content: its node, drawn over the record. */
function RecordContent({ node, row }: { node: SpecNode; row: Record<string, unknown> }) {
  const roots = useContext(RootsContext);
  return (
    <RowContext.Provider value={row}>
      <RootsContext.Provider value={{ ...roots, row }}>
        <Node node={node} />
      </RootsContext.Provider>
    </RowContext.Provider>
  );
}

const rowBound = (binding: Binding) => "root" in binding && binding.root === "row";

/**
 * A listing's state as the layout contract hands it to a layout — built-in or
 * a module's component — and its intents routed back to the listing.
 */
export function ContractLayout({ spec, node, drawing }: DrawnLayout): ReactNode {
  const roots = useContext(RootsContext);
  const { lang } = useContext(RendererContext);
  const say = useSay();
  const text = useText();
  const plan = spec.reads;
  const relations = node.relations as Record<string, OptionSourceSpec>;
  const schema = node.schema as { properties?: Record<string, { title?: unknown }> };
  const component = spec.type === "component";
  const bindings = component ? (spec.props as Record<string, Binding>) : {};

  // The props a built-in layout is given: its own keys once, its content per record.
  const fixed: Record<string, unknown> = component
    ? Object.fromEntries(
        Object.entries(bindings)
          .filter(([, binding]) => !rowBound(binding))
          .map(([name, binding]) => {
            const read = readBinding(binding, roots);
            return [name, read.present ? read.value : undefined];
          }),
      )
    : {
        windowed: drawing.windowed,
        pageSize: node.pageSize,
        recordKey: node.key,
        ...(spec.size !== undefined ? { size: spec.size } : {}),
        ...(spec.period !== undefined ? { period: spec.period } : {}),
        ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
        ...(plan.groups ? { group: plan.groups.property } : {}),
        ...(plan.span ? { start: plan.span.start, format: plan.span.format, ...(plan.span.end !== undefined ? { end: plan.span.end } : {}) } : {}),
        ...(plan.parent !== undefined ? { parent: plan.parent } : {}),
      };
  const perRecord = (row: Record<string, unknown>): Record<string, unknown> => {
    if (!component) {
      const title = plan.parent !== undefined && relations[plan.parent] ? optionOf(relations[plan.parent], row)?.label : undefined;
      return { content: <RecordContent node={spec.content as SpecNode} row={row} />, ...(title !== undefined ? { title } : {}) };
    }
    const props: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(bindings)) {
      if (!rowBound(binding)) continue;
      const read = readBinding(binding, { ...roots, row });
      props[name] = read.present ? read.value : undefined;
    }
    return props;
  };

  const record = (listed: ListedRecord): LayoutRecord => {
    const labels: Record<string, string> = {};
    for (const property of Object.keys(relations)) {
      const known = heldValues(listed.row[property]).map((value) => drawing.labels.label(property, value)?.label);
      if (known.length > 0 && known.every((label) => label !== undefined)) labels[property] = known.join(", ");
    }
    const style = drawing.rowStyle(listed.row);
    const failure = drawing.moveFailure(listed);
    return {
      key: listed.key,
      row: listed.row,
      props: perRecord(listed.row),
      labels,
      actions:
        drawing.hasActions || failure !== null ? (
          <div data-telo-part="row-actions">
            {drawing.hasActions && drawing.actions(listed)}
            {failure}
          </div>
        ) : null,
      ...(drawing.detail?.key === listed.key ? { detail: <div data-telo-part="listing-detail" ref={drawing.detail.ref} /> } : {}),
      ...(style !== undefined ? { style } : {}),
      selected: false,
      movable: drawing.movable(listed),
    };
  };
  const level = (read: ReadView | undefined): LayoutLevel => ({
    records: (read?.records ?? []).map(record),
    ...(read?.total !== undefined ? { total: read.total } : {}),
    hasMore: read?.hasMore ?? false,
    loading: read?.loading ?? true,
    ...(read?.failure ? { error: { code: read.failure.code, message: read.failure.message } } : {}),
  });
  /** A read with, under a `parent` plan, the children of every record expanded beneath it, at any depth. */
  const withChildren = (read: ReadView | undefined, group: string | undefined): LayoutLevel => {
    if (plan.parent === undefined) return level(read);
    const children: Record<string, LayoutLevel> = {};
    for (const each of drawing.reads) {
      if (each.position.parent !== undefined && each.position.group === group) children[each.position.parent] = level(each);
    }
    return { ...level(read), children };
  };
  const outermost = (group?: string) => drawing.reads.find((read) => read.position.group === group && read.position.parent === undefined);

  let top: LayoutLevel;
  let groups: LayoutGroup[] | undefined;
  if (plan.groups && drawing.groups) {
    const labels = plan.groups.labels;
    groups = drawing.groups.values.map((value) => {
      const own = withChildren(outermost(value.sent), value.sent);
      const written = labelFor(labels, value.value);
      const label = value.option?.label ?? (written !== undefined ? text(written) : value.value === null || value.value === undefined ? say("none") : String(value.value));
      const count = own.total ?? value.count;
      return { ...own, value: value.value, label, heading: count === undefined ? label : say("valueCount", { label, count }) };
    });
    top = {
      records: groups.flatMap((group) => group.records),
      hasMore: drawing.groups.hasMore,
      loading: drawing.groups.loading,
      ...(drawing.groups.failure ? { error: { code: drawing.groups.failure.code, message: drawing.groups.failure.message } } : {}),
    };
  } else {
    top = withChildren(outermost(), undefined);
  }

  const failed = drawing.reads.find((read) => read.failure)?.failure;
  const props: LayoutProps = {
    ...top,
    ...(drawing.state === "loading" ? { loading: true } : {}),
    ...(top.error === undefined && failed ? { error: { code: failed.code, message: failed.message } } : {}),
    props: fixed,
    ...(groups ? { groups } : {}),
    ...(plan.span ? { span: drawing.period ?? null } : {}),
    ...(plan.parent !== undefined ? { expanded: [...drawing.expanded] } : {}),
    sort: {
      ...(drawing.sort.value !== undefined ? { value: drawing.sort.value } : {}),
      sortable: drawing.sort.sortable.map((property) => {
        const title = schema.properties?.[property]?.title;
        // A model's title is its text, or a translated record where the page translated it.
        return { property, label: typeof title === "string" ? title : title && typeof title === "object" ? text(title as WireText) : property };
      }),
    },
    paging: node.paging === "scroll" ? "scroll" : "more",
    empty: drawing.empty,
    can: { open: drawing.open !== undefined, create: drawing.create !== undefined, move: spec.move !== undefined },
    words: { loadMore: say("loadMore"), moveTo: say("moveTo"), none: say("none"), newRecord: say("newRecord") },
    lang,
    onEndReached: (at) => {
      if (at?.parent !== undefined) {
        return drawing.reads.find((read) => read.position.parent === at.parent && (at.group === undefined || read.position.group === sentOf(at.group)))?.loadMore();
      }
      if (at && "group" in at) return outermost(sentOf(at.group))?.loadMore();
      if (plan.groups) return drawing.groups?.more();
      outermost()?.loadMore();
    },
    onPeriodChange: (period) => drawing.showPeriod(period),
    onExpand: (key, open) => drawing.expand(key, open),
    onOpen: (key) => drawing.open?.(key),
    onSortChange: (sort) => drawing.sort.set(sort),
    onMove: (key, to) => {
      const held = drawing.reads.flatMap((read) => read.records).find((each) => each.key === key);
      if (held) drawing.move(held, { ...held.row, ...to });
    },
    onCreate: (values) => {
      const own = [plan.groups?.property, plan.span?.start, plan.span?.end, plan.parent].filter((name) => name !== undefined);
      drawing.create?.(Object.fromEntries(Object.entries(values).filter(([name]) => own.includes(name))));
    },
  };

  if (component) {
    return <LoadedComponent module={spec.module} name={spec.export} stylesheets={spec.stylesheets} props={props as unknown as Record<string, unknown>} />;
  }
  const Layout = BUILT_IN_LAYOUTS[spec.type];
  return <Layout {...props} />;
}

/** A group's value as its read sends it. */
const sentOf = (value: unknown): string => String(value);
