import { useContext, useEffect, useRef, useState } from "react";
import type { Option } from "../contract/ui-react-controls.js";
import { fetchFacet, resolveParams, type FacetValue, type Param } from "./collection.js";
import type { FilterField } from "./filter-state.js";
import { useHost, useHostStore } from "./host.js";
import { facetRequest } from "./listing-reads.js";
import { useOptionPages, type ChoiceOption } from "./option-source.js";
import { useRelatedLabels, type RelatedLabels } from "./related-labels.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { labelFor, useSay, useText } from "./texts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import { plainTypes, type JsonSchema } from "./validation.js";

/** Where a bar's `values: present` fields read their values: its collection —
 *  its path as resolved, or why it does not resolve — under every filter but the field's own. */
export interface FacetScope {
  basePath: string | ErrorSpec;
  filters: Param[];
}

/** A filter's value as its property holds it: a number for a numeric
 *  property, a boolean for a boolean one, the text otherwise. */
export function typedValue(schema: JsonSchema, text: string): unknown {
  const types = plainTypes(schema);
  if ((types.includes("integer") || types.includes("number")) && text.trim() !== "" && Number.isFinite(Number(text))) return Number(text);
  if (types.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  return text;
}

interface FacetPages {
  values: FacetValue[];
  loading: boolean;
  failure?: ErrorSpec;
  more: boolean;
  next(): void;
}

/**
 * The present values of a property under `filters`, from the facet request,
 * page by page. A change announced for `basePath`, and a listing over it
 * reading itself again on its timer, read them again from the first page. The
 * first page resolves each value relative to now; a later one sends what its
 * cursor was issued for. A path that does not resolve reads nothing and is the
 * values' failure.
 */
export function useFacetPages(basePath: string | ErrorSpec, property: string, filters: Param[], limit: number, active: boolean): FacetPages {
  const host = useHost();
  const store = useHostStore();
  const { prefix } = useContext(RendererContext);
  const [changes, setChanges] = useState(0);
  const path = typeof basePath === "string" ? basePath : undefined;
  useEffect(() => {
    if (path === undefined) return;
    const again = () => setChanges((count) => count + 1);
    const stops = [host.onChanged(path, again), store.onReread(path, again)];
    return () => stops.forEach((stop) => stop());
  }, [path]);
  const query = JSON.stringify([path ?? null, property, filters, limit, changes]);
  const [state, setState] = useState<{ query?: string; values: FacetValue[]; cursor: string | null; sent: Param[]; loading: boolean; failure?: ErrorSpec }>({
    values: [],
    cursor: null,
    sent: [],
    loading: false,
  });
  const latest = useRef(0);
  const read = (cursor: string | undefined, append: boolean) => {
    if (path === undefined) return;
    const at = ++latest.current;
    const sent = append ? state.sent : resolveParams(filters, new Date());
    setState((held) => ({ ...held, query, loading: true }));
    fetchFacet(host, prefix, facetRequest(path, limit, property, sent, cursor)).then(
      (page) => {
        if (at !== latest.current) return;
        setState((held) => ({ query, values: append ? [...held.values, ...page.values] : page.values, cursor: page.next, sent, loading: false }));
      },
      (error) => {
        if (at !== latest.current) return;
        setState((held) => ({ ...held, query, loading: false, failure: errorSpec(error, "ERR_UI_REQUEST_FAILED") }));
      },
    );
  };
  useEffect(() => {
    if (active && state.query !== query) read(undefined, false);
  }, [query, active]);
  const current = state.query === query;
  if (typeof basePath !== "string") return { values: [], loading: false, failure: basePath, more: false, next: () => {} };
  return {
    values: current ? state.values : [],
    loading: !current || state.loading,
    ...(current && state.failure ? { failure: state.failure } : {}),
    more: current && state.cursor !== null,
    next: () => {
      if (current && !state.loading && state.cursor !== null) read(state.cursor, true);
    },
  };
}

/** What a filter offers to choose from, read page by page. */
export interface FilterChoices {
  options: Option[];
  loading: boolean;
  hasMore: boolean;
  failure?: ErrorSpec;
  next(): void;
}

/** A value a field offers, shown as its option says, its model label or itself. */
function useShown(field: FilterField, labels: RelatedLabels, source: string) {
  const say = useSay();
  const text = useText();
  return (value: unknown, option?: ChoiceOption): string => {
    const related = option ?? (field.options ? labels.label(source, value) : undefined);
    if (related) return related.label;
    const label = labelFor(field.labels, value);
    if (label) return text(label);
    if (typeof value === "boolean") return say(value ? "yes" : "no");
    return String(value);
  };
}

/** Values per facet page for a field with no option source: the contract's largest page. */
export const FACET_LIMIT = 100;

/** The chosen values the options do not hold, offered too so they stay shown. */
function withChosen(offered: Option[], chosen: string[], shown: (value: unknown) => string, field: FilterField): Option[] {
  const keys = new Set(offered.map((option) => option.key));
  return [...offered, ...chosen.filter((value) => !keys.has(value)).map((value) => ({ key: value, label: shown(typedValue(field.schema, value)) }))];
}

/**
 * The choices of a `values: present` field: the values the facet request
 * answers under every filter but the field's own, each shown with its count
 * and labelled through the field's option source where it has one. Nothing is
 * read while it is not `active`.
 */
export function usePresentChoices(field: FilterField, facet: FacetScope, chosen: string[], source: string, active = true): FilterChoices {
  const say = useSay();
  const pages = useFacetPages(facet.basePath, field.property, facet.filters, field.options?.pageSize ?? FACET_LIMIT, active);
  // The keys of each facet page are labelled in one batch of the source's page size.
  const labels = useRelatedLabels(field.options ? { [source]: field.options } : {}, {
    [source]: [...pages.values.map((each) => each.value), ...chosen.map((value) => typedValue(field.schema, value))],
  });
  const shown = useShown(field, labels, source);
  const offered = pages.values.map((each) => ({ key: String(each.value), label: say("valueCount", { label: shown(each.value), count: each.count }) }));
  return {
    options: withChosen(offered, chosen, shown, field),
    loading: pages.loading,
    hasMore: pages.more,
    ...(pages.failure ? { failure: pages.failure } : {}),
    next: pages.next,
  };
}

/** The choices of a `values: all` field over records: its option source's records, page by page. */
export function useRecordChoices(
  field: FilterField & { options: NonNullable<FilterField["options"]> },
  chosen: string[],
  labels: RelatedLabels,
  source: string,
): FilterChoices {
  const shown = useShown(field, labels, source);
  const pages = useOptionPages(field.options, useContext(RootsContext), "");
  const offered = pages.options.map((option) => ({ key: String(option.value), label: shown(option.value, option) }));
  return {
    options: withChosen(offered, chosen, shown, field),
    loading: pages.loading,
    hasMore: pages.more,
    ...(pages.failure ? { failure: pages.failure } : {}),
    next: pages.next,
  };
}
