import { useEffect, useState, type ReactNode } from "react";
import type { ComboboxGroup } from "../contract/ui-react-controls.js";
import type { Operator } from "./collection.js";
import { useControl } from "./effective-controls.js";
import { usePresentChoices, type FacetScope } from "./filter-choices.js";
import {
  filterKey,
  isSearch,
  withPreset,
  type FilterField,
  type FilterPreset,
  type Values,
} from "./filter-state.js";
import { commitToken, listedValues, readToken, readValue, spellingOf, tokenParts, type TokenField, type TokenReading } from "./filter-tokens.js";
import { optionKey, useOptionPages, type OptionSourceSpec } from "./option-source.js";
import type { RelatedLabels } from "./related-labels.js";
import { separated } from "./separated.js";
import { useSay, useText, type WireText } from "./texts.js";
import { TYPING_PAUSE } from "./typing-pause.js";
import { plainTypes } from "./validation.js";

/** A source read when nothing is, so the hooks that read one can be called as always. */
const NO_SOURCE: OptionSourceSpec = {
  type: "collection",
  schema: {},
  value: { value: null },
  label: { value: null },
  basePath: "",
  filters: {},
  pageSize: 1,
};

/** The field a source-less present read is pointed at while it is inactive. */
const NO_FIELD: FilterField = { property: "", operator: "eq", label: { set: "", key: "" }, schema: {}, pinned: false, control: "none", values: "all" };

/** Text, once it has rested: at once when it empties. */
function useRested(text: string): string {
  const [rested, setRested] = useState(text);
  useEffect(() => {
    if (text === "") return setRested("");
    const pause = setTimeout(() => setRested(text), TYPING_PAUSE);
    return () => clearTimeout(pause);
  }, [text]);
  return rested;
}

export interface SearchBoxProps {
  id: string;
  /** Every filter of the bar, the search first. */
  fields: FilterField[];
  placeholder: WireText;
  presets: FilterPreset[];
  draft: Values;
  /** The bar's own wording of a chip's operator and of a filter's values. */
  caption: (operator: Operator) => string;
  valuesOf: (field: FilterField, values: string[]) => string;
  /** Replace the bar's values; a choice applies as the bar's `apply` says. */
  change: (next: Values, how: "choice" | "command") => void;
  /** Empty some filters. */
  clear: (fields: FilterField[], how: "choice") => void;
  facetOf: (field: FilterField) => FacetScope;
  /** What the bar's buttons are: Apply, where it is `apply: button`, and Reset. */
  actions: ReactNode;
}

interface Suggestion {
  id: string;
  label: string;
  hint?: string;
  checked?: boolean;
  pick: () => void;
}

/**
 * A filter bar drawn as one search box: the filters holding a value as chips
 * before the input, and under it what the text could mean — the search, a
 * filter per field that takes the text, the values of a field named — taken by
 * the keyboard with the focus kept in the box. Text naming a property and an
 * operator (`status:draft`, `publishedOn>=2026-11-01`) is read as a token.
 */
export function SearchBox(props: SearchBoxProps) {
  const { fields, draft, presets, change, clear } = props;
  const say = useSay();
  const text = useText();
  const Combobox = useControl("Combobox");
  const Icon = useControl("Icon");
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState("");
  const [box, setBox] = useState<HTMLElement | null>(null);

  const search = fields.find(isSearch);
  const shown = fields.filter((field) => !isSearch(field) && field.control !== "none");
  const held = (field: FilterField) => draft[filterKey(field)] ?? [];
  const tokenFields: TokenField[] = shown.map((field) => ({
    property: field.property,
    operator: field.operator,
    schema: field.schema,
    labels:
      field.labels?.map((entry) => ({ value: entry.value, label: text(entry.label) })) ??
      (plainTypes(field.schema).includes("boolean") ? [{ value: true, label: say("yes") }, { value: false, label: say("no") }] : []),
    relation: field.options !== undefined && (field.operator === "eq" || field.operator === "in"),
  }));
  const title = (index: number) => {
    const same = shown.filter((other) => other.property === shown[index].property).length > 1;
    return same ? `${text(shown[index].label)} ${props.caption(shown[index].operator)}` : text(shown[index].label);
  };

  const reading: TokenReading = readToken(typed, tokenFields);
  const focus = "field" in reading && reading.field !== undefined ? reading.field : undefined;
  const focused = focus === undefined ? undefined : shown[focus];
  const parts = tokenParts(typed);
  // What of the token's value is being typed: its last value under `in`, else all of it.
  const needle = parts === undefined || focused === undefined ? "" : (focused.operator === "in" ? (parts.rest.split(",").at(-1) ?? "") : parts.rest).trim();
  const listed = focus === undefined ? undefined : listedValues(tokenFields[focus]);
  const choosesFromData = focused !== undefined && (focused.control === "auto" || focused.control === "select" || focused.control === "options");
  const present = choosesFromData && focused.values === "present" ? focused : undefined;
  const records = focus !== undefined && tokenFields[focus].relation && present === undefined ? focused : undefined;

  const pages = useOptionPages(records?.options ?? NO_SOURCE, {}, useRested(records ? needle : ""), records !== undefined);
  const counted = usePresentChoices(present ?? NO_FIELD, props.facetOf(present ?? NO_FIELD), present ? held(present) : [], present ? filterKey(present) : "", present !== undefined);

  const matches = (label: string) => needle === "" || label.toLowerCase().includes(needle.toLowerCase());
  const commit = (field: FilterField, values: string[]) => {
    change(commitToken(draft, field, values), "choice");
    setTyped("");
    setOpen(false);
  };
  const toggle = (field: FilterField, value: string) => {
    const now = held(field);
    const next = now.includes(value) ? now.filter((each) => each !== value) : [...now, value];
    if (next.length === 0) clear([field], "choice");
    else change({ ...draft, [filterKey(field)]: next }, "choice");
  };
  /** Choose one value of a field: checked under `in`, committed otherwise. */
  const choose = (field: FilterField, value: string) => (field.operator === "in" ? toggle(field, value) : commit(field, [value]));
  const checkedFor = (field: FilterField, value: string) => (field.operator === "in" ? held(field).includes(value) : undefined);
  const startOf = (index: number) => ({
    id: `field:${index}`,
    label: title(index),
    pick: () => setTyped(`${shown[index].property}${spellingOf(tokenFields, index)}`),
  });

  const groups: { name: string; label?: string; entries: Suggestion[] }[] = [];
  const entered = typed.trim();
  if (entered === "") {
    if (presets.length > 0) {
      groups.push({
        name: "presets",
        label: say("presets"),
        entries: presets.map((preset, index) => ({
          id: `preset:${index}`,
          label: text(preset.label),
          pick: () => {
            change(withPreset(presets, preset, draft), "command");
            setOpen(false);
          },
        })),
      });
    }
    const starts = shown.flatMap((field, index) => (field.operator === "absent" ? [] : [startOf(index)]));
    if (starts.length > 0) groups.push({ name: "fields", label: say("filters"), entries: starts });
  } else if (reading.kind === "text") {
    const asked: Suggestion[] = [];
    if (search) {
      asked.push({
        id: "search",
        label: say("searchChip", { text: entered }),
        pick: () => {
          change({ ...draft, [filterKey(search)]: [entered] }, "choice");
          setTyped("");
          setOpen(false);
        },
      });
    }
    shown.forEach((field, index) => {
      const token = tokenFields[index];
      const takesText =
        field.operator === "contains" ||
        ((field.operator === "eq" || field.operator === "in") && plainTypes(field.schema).includes("string") && listedValues(token) === undefined && !token.relation);
      if (!takesText) return;
      const raws = field.operator === "in" ? separated(entered) : [entered];
      const values = raws.map((raw) => readValue(token, raw));
      if (raws.length === 0 || values.some((value) => "reason" in value)) return;
      const read = values.map((value) => (value as { value: string }).value);
      asked.push({
        id: `value:${index}`,
        label: say("filterChip", { label: text(field.label), operator: props.caption(field.operator), value: props.valuesOf(field, read) }),
        pick: () => commit(field, read),
      });
    });
    groups.push({ name: "text", entries: asked });
    const lower = entered.toLowerCase();
    const named = shown.flatMap((field, index) =>
      field.operator !== "absent" && (text(field.label).toLowerCase().startsWith(lower) || field.property.toLowerCase().startsWith(lower)) ? [startOf(index)] : [],
    );
    if (named.length > 0) groups.push({ name: "fields", label: say("filters"), entries: named });
  } else if (focused !== undefined && focus !== undefined) {
    const entries: Suggestion[] = [];
    if (reading.kind === "token") {
      entries.push({
        id: "typed",
        label: say("filterChip", { label: text(focused.label), operator: props.caption(focused.operator), value: props.valuesOf(focused, reading.values) }),
        pick: () => commit(focused, reading.values),
      });
    }
    if (records) {
      for (const option of pages.options) {
        if (!records.options?.search && !matches(option.label)) continue;
        const value = String(option.value);
        entries.push({
          id: `record:${optionKey(option.value)}`,
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
          ...(checkedFor(records, value) === undefined ? {} : { checked: checkedFor(records, value) }),
          pick: () => choose(records, value),
        });
      }
      if (pages.more) entries.push({ id: "more", label: say("more"), pick: pages.next });
    } else if (present) {
      for (const option of counted.options) {
        if (!matches(option.label)) continue;
        entries.push({
          id: `present:${option.key}`,
          label: option.label,
          ...(checkedFor(present, option.key) === undefined ? {} : { checked: checkedFor(present, option.key) }),
          pick: () => choose(present, option.key),
        });
      }
      if (counted.hasMore) entries.push({ id: "more", label: say("more"), pick: counted.next });
    } else if (listed) {
      for (const option of listed) {
        if (!matches(option.label) && !matches(option.value)) continue;
        entries.push({
          id: `listed:${option.value}`,
          label: option.label,
          ...(checkedFor(focused, option.value) === undefined ? {} : { checked: checkedFor(focused, option.value) }),
          pick: () => choose(focused, option.value),
        });
      }
    }
    groups.push({ name: "values", label: title(focus), entries });
  }

  const sections: ComboboxGroup[] = groups.filter((group) => group.entries.length > 0).map((group) => ({ key: group.name, label: group.label, entries: group.entries.map(({ id, pick, ...entry }) => ({ key: id, ...entry })) }));
  const picks = new Map(groups.flatMap((group) => group.entries.map((entry) => [entry.id, entry.pick] as const)));
  const keys = sections.flatMap((group) => group.entries.map((entry) => entry.key));
  const signature = keys.join("\n");
  useEffect(() => setHighlight(""), [signature, open]);
  const highlighted = keys.includes(highlight) ? highlight : (keys[0] ?? "");
  // A token that is none, and offers nothing to pick, is marked with why.
  const reason = reading.kind === "invalid" && keys.length === 0 ? reading.reason : undefined;

  const chips = fields.filter((field) => field.control !== "none" && held(field).length > 0);
  return (
    <>
      <div data-telo-part="search-box" ref={setBox} data-reason={reason}>
        {chips.map((field) => {
          const label = isSearch(field)
            ? say("searchChip", { text: held(field)[0] })
            : say("filterChip", { label: text(field.label), operator: props.caption(field.operator), value: props.valuesOf(field, held(field)) });
          return (
            <span key={filterKey(field)} data-telo-part="search-token">
              {label}
              <button data-telo-part="search-token-remove" type="button" aria-label={say("clear", { label: text(field.label) })} onClick={() => clear([field], "choice")}>
                <Icon name="remove" />
              </button>
            </span>
          );
        })}
        <Combobox
          id={`${props.id}-search`}
          label={say("searchFilter")}
          invalid={reason !== undefined}
          required={false}
          disabled={false}
          placeholder={text(props.placeholder)}
          value={typed}
          open={open}
          anchor={box}
          groups={sections}
          highlighted={highlighted}
          onChange={(value) => {
            setTyped(value);
            setOpen(true);
          }}
          onOpenChange={setOpen}
          onHighlight={setHighlight}
          onPick={(key) => picks.get(key)?.()}
          onBackspace={() => {
            const last = chips.at(-1);
            if (last) clear([last], "choice");
          }}
        />
      </div>
      {props.actions}
    </>
  );
}
