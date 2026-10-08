import { ListFilter, Plus, X } from "lucide-react";
import { Collapsible, DropdownMenu, Label, Popover, ToggleGroup } from "radix-ui";
import { Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { styleAttribute } from "./bindings.js";
import type { Operator } from "./collection.js";
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
import { Icon } from "./icon.js";
import { Node, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { FilterContext, RendererContext } from "./renderer-context.js";
import { Surface, type SurfaceSpec } from "./surface.js";
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
}

/** What tells two filters on one property apart, where they share its label. */
const CAPTIONS: Record<Operator, string> = {
  eq: "is",
  contains: "contains",
  gt: "after",
  gte: "from",
  lt: "before",
  lte: "to",
  in: "one of",
};

/** How long typed text rests before it applies, under `apply: typing`. */
const TYPING_PAUSE = 300;

interface Group {
  label: string;
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

/** What a filter holds, as a chip says it. */
const shownValue = (field: FilterField, values: string[]): string =>
  values.map((value) => (plainTypes(field.schema).includes("boolean") ? (value === "true" ? "Yes" : "No") : value)).join(", ");

/** A filter bar: every table inside it obeys what is applied here. */
export function Filters({ node }: { node: SpecNode }) {
  const id = useId();
  const host = useHost();
  const store = useHostStore();
  const environment = useContext(RendererContext);
  const outer = useContext(FilterContext);
  const fields = node.fields as FilterField[];
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

  const kept = state.key === undefined || state.store.type === "memory" ? undefined : state.store.type;
  const storage = useMemo(() => (kept === undefined ? undefined : browserStorage(kept)), [kept]);
  const storedAt = state.key === undefined ? undefined : storageKey(environment.prefix, state.key);
  // Where the bar starts: the address when it carries any of the bar's keys,
  // then the store, then the declared defaults.
  const started = useMemo(() => {
    const addressed = state.key !== undefined && state.address ? readAddress(host.location.search, state.key, fields) : undefined;
    const read = storage && storedAt ? readStore(storage, storedAt, fields) : undefined;
    return { values: addressed ?? read?.stored?.values ?? defaults, open: read?.stored?.open, stale: read?.stale === true };
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
    refused.current = !writeStore(storage, kept, storedAt, { values: applied, open: chosenOpen ?? declaredOpen });
  }, [applied, chosenOpen]);
  const params = useMemo(() => [...outer, ...paramsOf(fields, applied)], [outer, fields, applied]);
  const held = (field: FilterField) => draft[filterKey(field)] ?? [];
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
    const control = (field: FilterField, index: number, caption?: string) => (
      <FilterControl
        field={field}
        id={`${id}-${index}`}
        name={caption ? `${field.label} ${caption}` : undefined}
        values={held(field)}
        onChange={(values, how) => set(field, values, how)}
        onCommit={commit}
      />
    );
    const drawn = (
      <div data-telo-part="filter" data-active={active}>
        <Label.Root data-telo-part="filter-label" htmlFor={`${id}-${group.members[0]}`}>
          {group.label}
        </Label.Root>
        {members.length === 1 ? (
          control(members[0], group.members[0])
        ) : (
          <div data-telo-part="filter-group">
            {members.map((field, position) => {
              const caption = CAPTIONS[field.operator];
              return (
                <div key={field.operator} data-telo-part="filter-bound">
                  <span data-telo-part="filter-caption">{caption}</span>
                  {control(field, group.members[position], caption)}
                </div>
              );
            })}
          </div>
        )}
        {chosenOnly && !pinned(group) && (
          <button data-telo-part="filter-remove" type="button" aria-label={`Remove ${group.label}`} onClick={() => remove(members)}>
            <Icon of={X} />
          </button>
        )}
      </div>
    );
    if (node.controls !== "chips") return <Fragment key={group.members[0]}>{drawn}</Fragment>;
    const summary = members
      .filter((field) => held(field).length > 0)
      .map((field) => (members.length > 1 ? `${CAPTIONS[field.operator]} ` : "") + shownValue(field, held(field)))
      .join(", ");
    return (
      <Popover.Root key={group.members[0]}>
        <Popover.Trigger data-telo-part="filter-chip" data-active={active}>
          {summary === "" ? group.label : `${group.label}: ${summary}`}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content data-telo-part="surface" data-surface="popover" align="start" sideOffset={6} collisionPadding={8}>
            {drawn}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  };
  // What folds, and what stays beside the toggle whatever is folded.
  const inside = folding ? shown.filter((group) => !pinned(group)) : shown;
  const outside = folding ? shown.filter(pinned) : [];
  const bar: ReactNode = (
    <>
      {inside.map(filter)}
      {chosenOnly && hidden.length > 0 && (
        <DropdownMenu.Root>
          {/* The trigger's own open state is the menu's to carry. */}
          <DropdownMenu.Trigger asChild>
            <button data-telo-part="filters-add" data-state={undefined} type="button">
              <Icon of={Plus} />
              Add filter
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content data-telo-part="menu" align="start" sideOffset={4}>
              {hidden.map((group) => (
                <DropdownMenu.Item
                  key={group.members[0]}
                  data-telo-part="menu-item"
                  onSelect={() => {
                    // On show, holding nothing.
                    const keys = group.members.map((index) => filterKey(fields[index]));
                    setRemoved(new Set([...removed].filter((key) => !keys.includes(key))));
                    const next = { ...draft };
                    for (const key of keys) next[key] ??= [];
                    change(next, "choice");
                  }}
                >
                  {group.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </>
  );
  // What acts on the whole bar is never folded away: whatever is pending, it is in reach.
  const actions: ReactNode = (
    <>
      {node.apply === "button" && (
        <button data-telo-part="filters-apply" type="button" onClick={apply}>
          Apply
        </button>
      )}
      <button data-telo-part="filters-reset" type="button" onClick={() => change(defaults, "command")}>
        Reset
        <Icon of={X} />
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
    const search = writeAddress(location.search, state.key, fields, applied);
    if (search.slice(1) !== new URLSearchParams(location.search).toString()) host.navigate(location.path + search + location.hash, { replace: true });
  }, [applied]);

  const folded = folds && (
    <button
      data-telo-part="filters-toggle"
      type="button"
      ref={toggle}
      aria-expanded={placement.type === "collapsible" ? (chosenOpen ?? declaredOpen) : undefined}
      onClick={() => (placement.type === "collapsible" ? setChosenOpen(!(chosenOpen ?? declaredOpen)) : openOverlay())}
    >
      <Icon of={ListFilter} />
      Filters
      {count > 0 && <span data-telo-part="filters-count">{count}</span>}
    </button>
  );

  const chosenPreset = activePreset(presets, draft);
  return (
    <div
      data-telo-part="filters"
      data-state="idle"
      data-placement={placement.type}
      data-side={placement.side}
      data-pending={sameValues(draft, applied) ? undefined : "true"}
      data-style={styleAttribute(node.style)}
    >
      {presets.length > 0 && (
        <ToggleGroup.Root
          data-telo-part="filters-presets"
          type="single"
          aria-label="Presets"
          value={chosenPreset === -1 ? "" : String(chosenPreset)}
          onValueChange={(value) => value !== "" && change(withPreset(presets, presets[Number(value)], draft), "command")}
        >
          {presets.map((preset, index) => (
            <ToggleGroup.Item key={preset.label} data-telo-part="filters-preset" value={String(index)}>
              {preset.label}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      )}
      {outside.map(filter)}
      {folded}
      {folding && actions}
      {folding && !folds ? null : placement.type === "collapsible" ? (
        <Collapsible.Root asChild open={chosenOpen ?? declaredOpen} onOpenChange={setChosenOpen}>
          <Collapsible.Content data-telo-part="filters-bar" forceMount>
            {bar}
          </Collapsible.Content>
        </Collapsible.Root>
      ) : surface ? (
        overlayShown && (
          <Surface spec={environment.compact && surface.compact ? surface.compact : surface} title="Filters" anchor={toggle} onClose={closeOverlay}>
            <div data-telo-part="filters-bar">{bar}</div>
            <div data-telo-part="form-actions">
              <button data-telo-part="submit" type="button" onClick={closeOverlay}>
                Done
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
                {`${field.label} ${CAPTIONS[field.operator]} ${shownValue(field, held(field))}`}
                <button data-telo-part="summary-chip-remove" type="button" aria-label={`Clear ${field.label}`} onClick={() => clear([field], "command")}>
                  <Icon of={X} />
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
