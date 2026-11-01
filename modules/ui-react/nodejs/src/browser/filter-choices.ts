import { useContext, useEffect, useRef, useState } from "react";
import type { Option } from "../contract/ui-react-controls.js";
import { fetchFacet, type FacetValue, type Param } from "./collection.js";
import type { FilterField } from "./filter-state.js";
import { useHost } from "./host.js";
import { facetRequest } from "./listing-reads.js";
import { useOptionPages, type ChoiceOption } from "./option-source.js";
import { useRelatedLabels, type RelatedLabels } from "./related-labels.js";
import { RendererContext } from "./renderer-context.js";
import { labelFor, useSay, useText } from "./texts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import { plainTypes, type JsonSchema } from "./validation.js";

/** Where a bar's `values: present` fields read their values: its collection,
 *  under every filter but the field's own. */
export interface FacetScope {
  basePath: string;
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
 * page by page. A change announced for `basePath` reads them again, from the
 * first page.
 */
export function useFacetPages(basePath: string, property: string, filters: Param[], limit: number, active: boolean): FacetPages {
  const host = useHost();
  const { prefix } = useContext(RendererContext);
  const [changes, setChanges] = useState(0);
  useEffect(() => host.onChanged(basePath, () => setChanges((count) => count + 1)), [basePath]);
  const query = JSON.stringify([basePath, property, filters, limit, changes]);
  const [state, setState] = useState<{ query?: string; values: FacetValue[]; cursor: string | null; loading: boolean; failure?: ErrorSpec }>({
    values: [],
    cursor: null,
    loading: false,
  });
  const latest = useRef(0);
  const read = (cursor: string | undefined, append: boolean) => {
    const at = ++latest.current;
    setState((held) => ({ ...held, query, loading: true }));
    fetchFacet(host, prefix, facetRequest(basePath, limit, property, filters, cursor)).then(
      (page) => {
        if (at !== latest.current) return;
        setState((held) => ({ query, values: append ? [...held.values, ...page.values] : page.values, cursor: page.next, loading: false }));
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
 * and labelled through the field's option source where it has one.
 */
export function usePresentChoices(field: FilterField, facet: FacetScope, chosen: string[], source: string): FilterChoices {
  const say = useSay();
  const pages = useFacetPages(facet.basePath, field.property, facet.filters, field.options?.pageSize ?? FACET_LIMIT, true);
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
  const pages = useOptionPages(field.options, {}, "");
  const offered = pages.options.map((option) => ({ key: String(option.value), label: shown(option.value, option) }));
  return {
    options: withChosen(offered, chosen, shown, field),
    loading: pages.loading,
    hasMore: pages.more,
    ...(pages.failure ? { failure: pages.failure } : {}),
    next: pages.next,
  };
}
