import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boundFilters, fetchRequest, filterParam, type Param } from "./collection.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import { optionKey, optionOf, type ChoiceOption, type OptionSourceSpec } from "./option-source.js";
import { RendererContext } from "./renderer-context.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

/** What one source has labelled: an option per value asked for, or `null`
 *  for one its answer did not hold. */
type Known = ReadonlyMap<string, ChoiceOption | null>;

export interface RelatedLabels {
  /** The option a value of a source is labelled with, once its lookup answered. */
  label(source: string, value: unknown): ChoiceOption | undefined;
  /** Lookups that failed, by source. */
  failures: Readonly<Record<string, ErrorSpec>>;
}

/** The property of a related record a value is looked up by: the source's `value` path of one step. */
const valueProperty = (spec: OptionSourceSpec): string | undefined =>
  "root" in spec.value && spec.value.path.length === 1 ? spec.value.path[0] : undefined;

/** Every value a property holds — each item of a list. */
export const heldValues = (value: unknown): unknown[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [value];

/**
 * The label engine: the values wanted from each source, as one render turn
 * collected them, looked up with `in` in batches of the source's `pageSize`,
 * a value already labelled — or already asked — never asked again. A change
 * announced for a source's `basePath` forgets its labels, so the values still
 * wanted are looked up again.
 */
export function useRelatedLabels(
  sources: Readonly<Record<string, OptionSourceSpec>>,
  wanted: Readonly<Record<string, readonly unknown[]>>,
  roots: Readonly<Record<string, unknown>> = {},
): RelatedLabels {
  const host = useHost();
  const { prefix } = useContext(RendererContext);
  const [known, setKnown] = useState<Readonly<Record<string, Known>>>({});
  const [failures, setFailures] = useState<Readonly<Record<string, ErrorSpec>>>({});
  const [forgotten, setForgotten] = useState(0);
  // Values asked for and not yet answered, by source; a forgetting starts a new generation.
  const asked = useRef(new Map<string, Set<string>>());
  const generation = useRef(new Map<string, number>());

  const basePaths = Object.entries(sources).map(([name, spec]) => [name, spec.basePath] as const);
  useEffect(() => {
    const stops = basePaths.map(([name, basePath]) =>
      host.onChanged(basePath, () => {
        generation.current.set(name, (generation.current.get(name) ?? 0) + 1);
        asked.current.delete(name);
        setKnown((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        setForgotten((count) => count + 1);
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [JSON.stringify(basePaths)]);

  const missing: Record<string, unknown[]> = {};
  for (const [name, values] of Object.entries(wanted)) {
    const spec = sources[name];
    if (!spec) continue;
    const held = known[name];
    const seen = new Set<string>();
    for (const value of values) {
      const key = optionKey(value);
      if (seen.has(key) || held?.has(key)) continue;
      seen.add(key);
      (missing[name] ??= []).push(value);
    }
  }
  const missingKey = JSON.stringify(missing);

  useEffect(() => {
    for (const [name, values] of Object.entries(missing)) {
      const spec = sources[name];
      const property = valueProperty(spec);
      const filters = boundFilters(spec.filters, roots);
      if (property === undefined || filters === undefined) continue;
      const inFlight = asked.current.get(name) ?? new Set<string>();
      asked.current.set(name, inFlight);
      const fresh = values.filter((value) => !inFlight.has(optionKey(value)));
      if (fresh.length === 0) continue;
      for (const value of fresh) inFlight.add(optionKey(value));
      const at = generation.current.get(name) ?? 0;
      for (let start = 0; start < fresh.length; start += spec.pageSize) {
        const batch = fresh.slice(start, start + spec.pageSize);
        const params: Param[] = [["limit", String(spec.pageSize)], ...filters, ...batch.map((value) => filterParam(property, "in", String(value)))];
        fetchRequest(host, prefix, { path: spec.basePath, params }).then(
          (page) => {
            if ((generation.current.get(name) ?? 0) !== at) return;
            setKnown((current) => {
              const next = new Map(current[name] ?? []);
              for (const value of batch) if (!next.has(optionKey(value))) next.set(optionKey(value), null);
              for (const row of page.rows) {
                const option = optionOf(spec, row);
                if (option) next.set(optionKey(option.value), option);
              }
              return { ...current, [name]: next };
            });
            setFailures((current) => {
              if (!(name in current)) return current;
              const next = { ...current };
              delete next[name];
              return next;
            });
          },
          (error) => {
            if ((generation.current.get(name) ?? 0) !== at) return;
            // Asked again on the next change announced for the source.
            setFailures((current) => ({ ...current, [name]: errorSpec(error, "ERR_UI_REQUEST_FAILED") }));
          },
        );
      }
    }
  }, [missingKey, forgotten]);

  return useMemo(
    () => ({
      label: (source, value) => known[source]?.get(optionKey(value)) ?? undefined,
      failures,
    }),
    [known, failures],
  );
}

/** The relations a listing labels its records through, for whatever draws a value of a record. */
export interface RelatedScope {
  relations: Readonly<Record<string, OptionSourceSpec>>;
  labels: RelatedLabels;
}

export const RelatedContext = createContext<RelatedScope | undefined>(undefined);

/** A related record's label, linked where its source gives a link. */
function RelatedLabel({ option }: { option: ChoiceOption }) {
  const store = useHostStore();
  const href = option.href === undefined ? undefined : linkAddress(store, option.href);
  return href ? (
    <a data-telo-part="link" href={href}>
      {option.label}
    </a>
  ) : (
    <>{option.label}</>
  );
}

/**
 * A value of a property with a relation: each related record it names as its
 * label, linked where the relation gives a link; a value not yet labelled — or
 * that names no record — as it is.
 */
export function RelatedValue({ relation, value }: { relation: string; value: unknown }): ReactNode {
  const scope = useContext(RelatedContext);
  const values = heldValues(value);
  return values.map((each, index) => {
    const option = scope?.labels.label(relation, each);
    return (
      <Fragment key={index}>
        {index > 0 && ", "}
        {option ? <RelatedLabel option={option} /> : String(each)}
      </Fragment>
    );
  });
}
