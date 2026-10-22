import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { readBinding, type Binding } from "./bindings.js";
import { boundFilters, fetchPage, filterParam, type Operator, type Param } from "./collection.js";
import { useHost } from "./host.js";
import { RendererContext, underMount } from "./renderer-context.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

/** Where a field's options come from, as the page document says. */
export interface OptionSourceSpec {
  type: "collection";
  schema: JsonSchema;
  value: Binding;
  label: Binding;
  hint?: Binding;
  href?: Binding;
  basePath: string;
  filters: Record<string, Binding>;
  pageSize: number;
  search?: { property: string; operator: Operator };
}

/** One option: the value choosing it yields, and how it is shown. */
export interface ChoiceOption {
  value: unknown;
  label: string;
  hint?: string;
  href?: string;
}

/** A value as the key options and chosen values are matched by. */
export const optionKey = (value: unknown): string => JSON.stringify(value);

const text = (binding: Binding | undefined, row: Record<string, unknown>): string | undefined => {
  if (!binding) return undefined;
  const read = readBinding(binding, { row });
  return read.present && read.value !== null ? String(read.value) : undefined;
};

export function optionOf(spec: OptionSourceSpec, row: Record<string, unknown>): ChoiceOption | undefined {
  const value = readBinding(spec.value, { row });
  if (!value.present) return undefined;
  const hint = text(spec.hint, row);
  const href = text(spec.href, row);
  return { value: value.value, label: text(spec.label, row) ?? String(value.value), ...(hint ? { hint } : {}), ...(href ? { href } : {}) };
}

/** The filter a chosen value is looked up by: `value`'s one property under `in`. */
const valueProperty = (spec: OptionSourceSpec): string | undefined =>
  "root" in spec.value && spec.value.path.length === 1 ? spec.value.path[0] : undefined;

export interface OptionPages {
  options: ChoiceOption[];
  loading: boolean;
  failure?: ErrorSpec;
  /** Whether a further page exists. */
  more: boolean;
  /** Read the next page; nothing while one is in flight. */
  next(): void;
  /** Whether the source can read anything now: every filter it reads holds a value. */
  reading: boolean;
}

/**
 * The options a source offers over the roots in scope, read page by page.
 * Nothing is read, and nothing offered, while a filter the source reads holds
 * nothing; a change of filters or search starts again from the first page, and
 * an answer to an older one is discarded.
 */
export function useOptionPages(spec: OptionSourceSpec, roots: Readonly<Record<string, unknown>>, search = "", active = true): OptionPages {
  const host = useHost();
  const collectionAt = underMount(useContext(RendererContext).prefix, spec.basePath);
  const filters = boundFilters(spec.filters, roots);
  const searched: Param[] = search !== "" && spec.search ? [filterParam(spec.search.property, spec.search.operator, search)] : [];
  const key = filters === undefined ? undefined : JSON.stringify([...filters, ...searched]);
  const [state, setState] = useState<{ key?: string; options: ChoiceOption[]; cursor: string | null; loading: boolean; failure?: ErrorSpec }>({
    options: [],
    cursor: null,
    loading: false,
  });
  const latest = useRef(0);
  const inFlight = useRef(false);

  const read = (cursor: string | undefined, append: boolean) => {
    if (filters === undefined) return;
    const request = ++latest.current;
    inFlight.current = true;
    setState((held) => ({ ...held, key, loading: true }));
    fetchPage(host, collectionAt, { limit: spec.pageSize, cursor, filters: [...filters, ...searched] }).then(
      (page) => {
        if (request !== latest.current) return;
        inFlight.current = false;
        const options = page.rows.flatMap((row) => optionOf(spec, row) ?? []);
        setState((held) => ({ key, options: append ? [...held.options, ...options] : options, cursor: page.next, loading: false }));
      },
      (error) => {
        if (request !== latest.current) return;
        inFlight.current = false;
        setState((held) => ({ ...held, key, loading: false, failure: errorSpec(error, "ERR_UI_REQUEST_FAILED") }));
      },
    );
  };

  useEffect(() => {
    if (!active) return;
    if (key === undefined) {
      latest.current++;
      inFlight.current = false;
      setState({ options: [], cursor: null, loading: false });
      return;
    }
    if (state.key === key && (state.loading || state.options.length > 0 || state.cursor !== null)) return;
    read(undefined, false);
  }, [key, active]);

  const current = state.key === key && key !== undefined;
  return {
    options: current ? state.options : [],
    loading: current && state.loading,
    ...(current && state.failure ? { failure: state.failure } : {}),
    more: current && state.cursor !== null,
    next: () => {
      if (!current || inFlight.current || state.cursor === null) return;
      read(state.cursor, true);
    },
    reading: key !== undefined,
  };
}

/**
 * The options of the chosen values, labelled: those the read pages hold, and
 * the rest looked up by `value` under `in` — in batches of the source's page
 * size, under its current filters. A chosen value no lookup returns is dropped
 * through `onDropped`; so is every value while the source can read nothing.
 * Labels are never kept beyond what the source answers.
 */
export function useChosenOptions(
  spec: OptionSourceSpec,
  roots: Readonly<Record<string, unknown>>,
  chosen: unknown[],
  offered: ChoiceOption[],
  onDropped: (kept: unknown[]) => void,
): ChoiceOption[] {
  const host = useHost();
  const collectionAt = underMount(useContext(RendererContext).prefix, spec.basePath);
  const filters = boundFilters(spec.filters, roots);
  const filtersKey = filters === undefined ? undefined : JSON.stringify(filters);
  const [known, setKnown] = useState<{ filters?: string; options: Map<string, ChoiceOption> }>({ options: new Map() });
  const latest = useRef(0);
  const dropped = useRef(onDropped);
  dropped.current = onDropped;
  const fresh = known.filters === filtersKey;
  const labelled = useMemo(() => {
    const map = new Map(fresh ? known.options : []);
    for (const option of offered) map.set(optionKey(option.value), option);
    return map;
  }, [known, offered, fresh]);
  const missing = chosen.filter((value) => !labelled.has(optionKey(value)));
  const missingKey = JSON.stringify(missing);

  useEffect(() => {
    if (chosen.length === 0) return;
    if (filters === undefined) {
      dropped.current([]);
      return;
    }
    // A change of filters holds every chosen value to them again.
    const asked = fresh ? missing : chosen;
    const property = valueProperty(spec);
    if (asked.length === 0 || property === undefined) return;
    const request = ++latest.current;
    const batches: unknown[][] = [];
    for (let at = 0; at < asked.length; at += spec.pageSize) batches.push(asked.slice(at, at + spec.pageSize));
    Promise.all(
      batches.map((batch) =>
        fetchPage(host, collectionAt, {
          limit: spec.pageSize,
          filters: [...filters, ...batch.map((value) => filterParam(property, "in", String(value)))],
        }),
      ),
    ).then(
      (pages) => {
        if (request !== latest.current) return;
        const found = new Map(fresh ? known.options : []);
        for (const row of pages.flatMap((page) => page.rows)) {
          const option = optionOf(spec, row);
          if (option) found.set(optionKey(option.value), option);
        }
        setKnown({ filters: filtersKey, options: found });
        const kept = chosen.filter((value) => found.has(optionKey(value)) || (fresh && labelled.has(optionKey(value))));
        if (kept.length !== chosen.length) dropped.current(kept);
      },
      // A lookup that fails labels nothing and drops nothing: the values are
      // shown as they are until a lookup answers.
      () => undefined,
    );
  }, [filtersKey, missingKey]);

  return chosen.map((value) => labelled.get(optionKey(value)) ?? { value, label: String(value) });
}
