import { TYPING_PAUSE } from "./typing-pause.js";
import { Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useControl, useControls } from "./effective-controls.js";
import { styleAttribute } from "./bindings.js";
import type { Operator } from "./collection.js";
import { typedValue } from "./filter-choices.js";
import { FilterControl } from "./filter-control.js";
import {
  activeCount,
  activePreset,
  browserStorage,
  declaredDefaults,
  filterKey,
  paramsOf,
  readAddress,
  readStore,
  sameValues,
  storageKey,
  withPreset,
  writeAddress,
  writeStore,
  type FilterField,
  type FilterPreset,
  type Values,
} from "./filter-state.js";
import { useHost, useHostStore } from "./host.js";
import type { OptionSourceSpec } from "./option-source.js";
import { useRelatedLabels, type RelatedLabels } from "./related-labels.js";
import { Node, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { FilterContext, RendererContext } from "./renderer-context.js";
import { Surface, useHeldInside, type SurfaceSpec } from "./surface.js";
import { labelFor, useSay, useText, type Say, type WireText } from "./texts.js";
import { plainTypes } from "./validation.js";

/** Where a bar's controls sit, as the page document says it. */
interface Placement {
  type: "above" | "aside" | "collapsible" | "overlay";
  side?: "start" | "end";
  open?: boolean;
  surface?: SurfaceSpec;
  /** The placement used instead on a narrow viewport. */
  compact?: Placement;
}

interface BarState {
  /** Present when the bar keeps its state anywhere but memory. */
  key?: string;
  address: boolean;
  store: { type: "memory" | "local" | "session" };
  /** The properties whose filters are kept. */
  fields: string[];
}

/** The word telling two filters on one property apart, where they share its label. */
export const CAPTIONS: Record<Operator, string> = {
  eq: "operatorEq",
  contains: "operatorContains",
  gt: "operatorGt",
  gte: "operatorGte",
  lt: "operatorLt",
  lte: "operatorLte",
  in: "operatorIn",
  absent: "operatorAbsent",
};

/** How long typed text rests before it applies, under `apply: typing`. */

interface Group {
  label: WireText;
  /** Positions in the node's `fields`. */
  members: number[];
}

/** The fields by property, each property where it first appears: a range is
 *  two filters on one property, and is shown as one. */
function groupsOf(fields: FilterField[]): Group[] {
  const byProperty = new Map<string, Group>();
  fields.forEach((field, index) => {
    // A filter with no control is set by a preset or a default, and drawn nowhere.
    if (field.control === "none") return;
    const group = byProperty.get(field.property);
    if (group) group.members.push(index);
    else byProperty.set(field.property, { label: field.label, members: [index] });
  });
  return [...byProperty.values()];
}

/** What a filter holds, as a chip says it: each related record's label, each
 *  value's label, yes or no, or the value. */
function shownValue(field: FilterField, values: string[], say: Say, text: (label: WireText) => string, labels: RelatedLabels): string {
  return values
    .map((value) => {
      const related = field.options ? labels.label(filterKey(field), typedValue(field.schema, value)) : undefined;
      if (related) return related.label;
      if (field.operator === "absent" || plainTypes(field.schema).includes("boolean")) return say(value === "true" ? "yes" : "no");
      const label = labelFor(field.labels, value);
      return label ? text(label) : value;
    })
    .join(", ");
}

/**
 * A filter chip and the popover holding its filters. The chip is the
 * renderer's: it opens and closes the popover, and a press on it is never one
 * outside the popover, so it is what closes an open one.
 */
function FilterChip({ active, label, children }: { active?: string; label: string; children: ReactNode }) {
  const control = useControls();
  const [open, setOpen] = useState(false);
  const Popover = open ? control("Popover") : undefined;
  const chip = useRef<HTMLButtonElement | null>(null);
  const onChip = useHeldInside();
  return (
    <>
      <button
        data-telo-part="filter-chip"
        type="button"
        ref={chip}
        data-active={active}
        data-state={open ? "open" : "closed"}
        // A theme may cut a long chip short; hovering shows it whole.
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDownCapture={onChip.mark}
        onFocusCapture={onChip.mark}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {Popover && (
        <Popover
          open
          anchor={chip.current}
          side="bottom"
          align="start"
          attributes={{ "data-surface": "popover" }}
          onOpenChange={(next, reason) => {
            // A press on the chip is the chip's own: its click is what closes the popover.
            if (!next && !(reason === "outside" && onChip.inside())) setOpen(false);
          }}
        >
          {children}
        </Popover>
      )}
    </>
  );
}

/** The list of the filters a bar can add, opened from its button. */
function AddFilter({ items, onAdd }: { items: { key: string; label: string }[]; onAdd: (key: string) => void }) {
  const say = useSay();
  const Menu = useControl("Menu");
  const Icon = useControl("Icon");
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} items={items} onOpenChange={setOpen} onChange={onAdd}>
      <button data-telo-part="filters-add" type="button">
        <Icon name="add" />
        {say("addFilter")}
      </button>
    </Menu>
  );
}

/** A filter bar: every listing inside it obeys what is applied here. */
export function Filters({ node }: { node: SpecNode }) {
  const id = useId();
  const control = useControls();
  const Icon = useControl("Icon");
  const say = useSay();
  const text = useText();
  const caption = (operator: Operator) => say(CAPTIONS[operator]);
  const valuesOf = (field: FilterField, values: string[]) => shownValue(field, values, say, (label) => text(label), chosenLabels);
  const host = useHost();
  const store = useHostStore();
  const environment = useContext(RendererContext);
  const outer = useContext(FilterContext);
  const fields = node.fields as FilterField[];
  const basePath = node.basePath as string;
  const presets = node.presets as FilterPreset[];
  const state = node.state as BarState;
  const chosenOnly = node.show === "chosen";
  const declared = node.placement as Placement;
  const placement = environment.compact && declared.compact ? declared.compact : declared;
  // A placement that folds keeps the pinned filters and the bar's own buttons
  // outside the fold; over a bar with no filter it could fold, there is no fold.
  const folding = placement.type === "collapsible" || placement.type === "overlay";
  const folds = folding && fields.some((field) => !field.pinned && field.control !== "none");
  // What a collapsible bar starts as, at whichever width it is one.
  const declaredOpen = [declared, declared.compact].find((each) => each?.type === "collapsible")?.open ?? false;
  const defaults = useMemo(() => declaredDefaults(fields), [fields]);
  // Only the filters of the properties the state keeps are read back and written.
  const keptFields = useMemo(() => fields.filter((field) => state.fields.includes(field.property)), [fields]);
  const keptValues = (values: Values): Values =>
    Object.fromEntries(Object.entries(values).filter(([key]) => keptFields.some((field) => filterKey(field) === key)));

  const kept = state.key === undefined || state.store.type === "memory" ? undefined : state.store.type;
  const storage = useMemo(() => (kept === undefined ? undefined : browserStorage(kept)), [kept]);
  const storedAt = state.key === undefined ? undefined : storageKey(environment.prefix, state.key);
  // Where the bar starts: the address when it carries any of the bar's keys,
  // then the store, then the declared defaults.
  const started = useMemo(() => {
    const addressed = state.key !== undefined && state.address ? readAddress(host.location.search, state.key, keptFields) : undefined;
    const read = storage && storedAt ? readStore(storage, storedAt, keptFields) : undefined;
    // A filter the state does not keep starts at its default whatever was kept.
    const unkept = Object.fromEntries(Object.entries(defaults).filter(([key]) => !keptFields.some((field) => filterKey(field) === key)));
    const kept = addressed ?? read?.stored?.values;
    return { values: kept ? { ...unkept, ...kept } : defaults, open: read?.stored?.open, stale: read?.stale === true };
  }, []);

  // What the controls show, and what the tables are asked for.
  const [draft, setDraft] = useState<Values>(started.values);
  const [applied, setApplied] = useState<Values>(started.values);
  // The fold state the user chose; until then, the placement's own.
  const [chosenOpen, setChosenOpen] = useState<boolean | undefined>(started.open);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // The filters taken off show whose declared default was cleared with them:
  // holding nothing is what records the cleared default, so it cannot also
  // say that the filter is on show.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(
    () => new Set(fields.filter((field) => field.default && started.values[filterKey(field)]?.length === 0).map(filterKey)),
  );
  const toggle = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pause.current), []);

  const apply = () => {
    clearTimeout(pause.current);
    setApplied((current) => (sameValues(current, latest.current) ? current : latest.current));
  };
  const change = (next: Values, how: "choice" | "typed" | "command") => {
    latest.current = next;
    setDraft(next);
    // A command acts on the whole bar as it then stands, whatever waits in it.
    if (how === "command") return apply();
    if (node.apply === "button") return;
    if (how === "choice") return apply();
    if (node.apply !== "typing") return;
    clearTimeout(pause.current);
    pause.current = setTimeout(apply, TYPING_PAUSE);
  };
  const commit = () => {
    if (node.apply !== "button") apply();
  };
  const set = (field: FilterField, values: string[], how: "choice" | "typed") => change({ ...draft, [filterKey(field)]: values }, how);
  /** Empty some filters. One with a declared default is kept, holding nothing —
   *  that is what says the default was cleared; any other is forgotten. */
  const clear = (cleared: FilterField[], how: "choice" | "command") => {
    const next = { ...draft };
    for (const field of cleared) {
      if (field.default) next[filterKey(field)] = [];
      else delete next[filterKey(field)];
    }
    change(next, how);
  };
  const remove = (members: FilterField[]) => {
    setRemoved(new Set([...removed, ...members.map(filterKey)]));
    clear(members, "choice");
  };

  // Every change is written to the store; an entry the store held wrongly is
  // rewritten as soon as it was read.
  const written = useRef(false);
  const refused = useRef(false);
  useEffect(() => {
    const first = !written.current;
    written.current = true;
    if (first && !started.stale) return;
    if (!storage || !storedAt || !kept || refused.current) return;
    // A store that takes nothing is left alone from then on: the bar is in memory.
    refused.current = !writeStore(storage, kept, storedAt, { values: keptValues(applied), open: chosenOpen ?? declaredOpen });
  }, [applied, chosenOpen]);
  const params = useMemo(() => [...outer, ...paramsOf(fields, applied)], [outer, fields, applied]);
  const held = (field: FilterField) => draft[filterKey(field)] ?? [];
  // The chosen records of the fields offering records, labelled for the chips and the controls.
  const sources = useMemo(
    () => Object.fromEntries(fields.flatMap((field) => (field.options ? [[filterKey(field), field.options] as [string, OptionSourceSpec]] : []))),
    [fields],
  );
  const chosenLabels = useRelatedLabels(
    sources,
    Object.fromEntries(fields.filter((field) => field.options).map((field) => [filterKey(field), held(field).map((value) => typedValue(field.schema, value))])),
  );
  /** Where a present field's values are read: the bar's collection, under
   *  every filter applied around and in the bar but the field's own. */
  const facetOf = (field: FilterField) => ({
    basePath,
    filters: [...outer, ...paramsOf(fields.filter((other) => filterKey(other) !== filterKey(field)), applied)],
  });
  const offShow = (field: FilterField) => removed.has(filterKey(field)) && held(field).length === 0;
  const onShow = (group: Group) =>
    !chosenOnly || group.members.some((index) => fields[index].pinned || (filterKey(fields[index]) in draft && !offShow(fields[index])));
  const pinned = (group: Group) => group.members.some((index) => fields[index].pinned);
  const groups = groupsOf(fields);
  const shown = groups.filter(onShow);
  const hidden = groups.filter((group) => !onShow(group));
  const count = activeCount(fields, draft);

  const filter = (group: Group) => {
    const members = group.members.map((index) => fields[index]);
    const active = members.some((field) => held(field).length > 0) ? "true" : undefined;
    const control = (field: FilterField, index: number, operator?: string) => (
      <FilterControl
        field={field}
        id={`${id}-${index}`}
        name={operator ? say("filterControl", { label: text(field.label), operator }) : undefined}
        values={held(field)}
        onChange={(values, how) => set(field, values, how)}
        onCommit={commit}
        facet={facetOf(field)}
        labels={chosenLabels}
        source={filterKey(field)}
      />
    );
    const drawn = (
      <div data-telo-part="filter" data-active={active}>
        <label data-telo-part="filter-label" htmlFor={`${id}-${group.members[0]}`}>
          {text(group.label)}
        </label>
        {members.length === 1 ? (
          control(members[0], group.members[0])
        ) : (
          <div data-telo-part="filter-group">
            {members.map((field, position) => {
              const operator = caption(field.operator);
              return (
                <div key={field.operator} data-telo-part="filter-bound">
                  <span data-telo-part="filter-caption">{operator}</span>
                  {control(field, group.members[position], operator)}
                </div>
              );
            })}
          </div>
        )}
        {chosenOnly && !pinned(group) && (
          <button data-telo-part="filter-remove" type="button" aria-label={say("remove", { label: text(group.label) })} onClick={() => remove(members)}>
            <Icon name="remove" />
          </button>
        )}
      </div>
    );
    if (node.controls !== "chips") return <Fragment key={group.members[0]}>{drawn}</Fragment>;
    const summary = members
      .filter((field) => held(field).length > 0)
      .map((field) => (members.length > 1 ? `${caption(field.operator)} ` : "") + valuesOf(field, held(field)))
      .join(", ");
    return (
      <FilterChip key={group.members[0]} active={active} label={summary === "" ? text(group.label) : say("filterGroupSummary", { label: text(group.label), summary })}>
        {drawn}
      </FilterChip>
    );
  };
  // What folds, and what stays beside the toggle whatever is folded.
  const inside = folding ? shown.filter((group) => !pinned(group)) : shown;
  const outside = folding ? shown.filter(pinned) : [];
  const bar: ReactNode = (
    <>
      {inside.map(filter)}
      {chosenOnly && hidden.length > 0 && (
        <AddFilter
          items={hidden.map((group) => ({ key: String(group.members[0]), label: text(group.label) }))}
          onAdd={(chosen) => {
            // On show, holding nothing.
            const group = hidden.find((each) => String(each.members[0]) === chosen);
            if (!group) return;
            const keys = group.members.map((index) => filterKey(fields[index]));
            setRemoved(new Set([...removed].filter((key) => !keys.includes(key))));
            const next = { ...draft };
            for (const key of keys) next[key] ??= [];
            change(next, "choice");
          }}
        />
      )}
    </>
  );
  // What acts on the whole bar is never folded away: whatever is pending, it is in reach.
  const actions: ReactNode = (
    <>
      {node.apply === "button" && (
        <button data-telo-part="filters-apply" type="button" onClick={apply}>
          {say("apply")}
        </button>
      )}
      <button data-telo-part="filters-reset" type="button" onClick={() => change(defaults, "command")}>
        {say("reset")}
        <Icon name="reset" />
      </button>
    </>
  );

  // A filter overlay is a surface like any other: its own compact surface and
  // its address are honoured, the address with nothing to name but "open".
  const surface = placement.type === "overlay" ? (placement.surface as SurfaceSpec) : undefined;
  const address = surface?.address?.name;
  const overlayShown = address === undefined ? overlayOpen : openValue(host.location.search, address) === "";
  const openOverlay = () => {
    if (address === undefined) setOverlayOpen(true);
    else store.open(address, "", [address]);
  };
  const closeOverlay = () => {
    if (address === undefined) setOverlayOpen(false);
    else store.close(address);
  };

  // The address says what is applied, in the entry it is in: it is replaced,
  // never pushed. The store carries it through a close and a step in history.
  useEffect(() => {
    if (state.key === undefined || !state.address) return;
    const location = store.snapshot().location;
    const search = writeAddress(location.search, state.key, keptFields, applied);
    if (search.slice(1) !== new URLSearchParams(location.search).toString()) host.navigate(location.path + search + location.hash, { replace: true });
  }, [applied]);

  const folded = folds && (
    <button
      data-telo-part="filters-toggle"
      type="button"
      ref={toggle}
      aria-expanded={placement.type === "collapsible" ? (chosenOpen ?? declaredOpen) : undefined}
      aria-controls={placement.type === "collapsible" ? `${id}-bar` : undefined}
      onClick={() => (placement.type === "collapsible" ? setChosenOpen(!(chosenOpen ?? declaredOpen)) : openOverlay())}
    >
      <Icon name="filter" />
      {say("filters")}
      {count > 0 && <span data-telo-part="filters-count">{count}</span>}
    </button>
  );

  const chosenPreset = activePreset(presets, draft);
  const PresetGroup = presets.length > 0 ? control("OptionGroup") : undefined;
  return (
    <div
      data-telo-part="filters"
      data-state="idle"
      data-placement={placement.type}
      data-side={placement.side}
      data-pending={sameValues(draft, applied) ? undefined : "true"}
      data-style={styleAttribute(node.style)}
    >
      {PresetGroup && (
        <PresetGroup
          id={`${id}-presets`}
          label={say("presets")}
          invalid={false}
          required={false}
          disabled={false}
          parts={{ root: "filters-presets", option: "filters-preset" }}
          multiple={false}
          options={presets.map((preset, index) => ({ key: String(index), label: text(preset.label) }))}
          value={chosenPreset === -1 ? [] : [String(chosenPreset)]}
          // A preset is a command; choosing the chosen one again leaves the bar as it is.
          onChange={([chosen]) => chosen !== undefined && change(withPreset(presets, presets[Number(chosen)], draft), "command")}
        />
      )}
      {outside.map(filter)}
      {folded}
      {folding && actions}
      {folding && !folds ? null : placement.type === "collapsible" ? (
        // A disclosure: the toggle shows and hides the bar, which stays mounted with what it holds.
        <div data-telo-part="filters-bar" id={`${id}-bar`} data-state={(chosenOpen ?? declaredOpen) ? "open" : "closed"} hidden={!(chosenOpen ?? declaredOpen)}>
          {bar}
        </div>
      ) : surface ? (
        overlayShown && (
          <Surface spec={environment.compact && surface.compact ? surface.compact : surface} title={say("filters")} anchor={toggle} onClose={closeOverlay}>
            <div data-telo-part="filters-bar">{bar}</div>
            <div data-telo-part="form-actions">
              <button data-telo-part="submit" type="button" onClick={closeOverlay}>
                {say("done")}
              </button>
            </div>
          </Surface>
        )
      ) : (
        <div data-telo-part="filters-bar">
          {bar}
          {actions}
        </div>
      )}
      {node.summary === "chips" && (
        <div data-telo-part="filters-summary">
          {fields
            .filter((field) => field.control !== "none" && held(field).length > 0)
            .map((field) => (
              <span key={filterKey(field)} data-telo-part="summary-chip">
                {say("filterChip", { label: text(field.label), operator: caption(field.operator), value: valuesOf(field, held(field)) })}
                <button
                  data-telo-part="summary-chip-remove"
                  type="button"
                  aria-label={say("clear", { label: text(field.label) })}
                  onClick={() => clear([field], "command")}
                >
                  <Icon name="remove" />
                </button>
              </span>
            ))}
        </div>
      )}
      <FilterContext.Provider value={params}>
        <div data-telo-part="filters-content">
          <Node node={node.content} />
        </div>
      </FilterContext.Provider>
    </div>
  );
}
