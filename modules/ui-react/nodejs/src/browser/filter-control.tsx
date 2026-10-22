import { useContext, useEffect, useState } from "react";
import type { Option, Semantics } from "../contract/ui-react-controls.js";
import { MultiSelectList, SelectList } from "./choice-lists.js";
import { useControls } from "./effective-controls.js";
import type { FilterField } from "./filter-state.js";
import { useShowValue, type ShowValue } from "./record-fields.js";
import { RendererContext } from "./renderer-context.js";
import { separated } from "./separated.js";
import { useSay, useText } from "./texts.js";
import { plainTypes, type JsonSchema } from "./validation.js";

interface FilterControlProps {
  field: FilterField;
  id: string;
  /** The control's accessible name where no label points at it alone. */
  name?: string;
  values: string[];
  /** A choice is whole when it is made; typed text is not until it is committed. */
  onChange: (values: string[], how: "choice" | "typed") => void;
  /** Typed text is meant: Enter, or leaving the control. */
  onCommit: () => void;
}

/** What a filter is chosen from: its property's listed values, or yes and no,
 *  each shown as `show` says. */
function optionsOf(schema: JsonSchema, show: ShowValue): Option[] | undefined {
  const listed: unknown[] | undefined = Array.isArray(schema.enum) ? schema.enum : plainTypes(schema).includes("boolean") ? [true, false] : undefined;
  return listed?.map((option) => ({ key: String(option), label: show(option) }));
}

/** One filter's control, as its field says it is entered. */
export function FilterControl({ field, id, name, values, onChange, onCommit }: FilterControlProps) {
  const say = useSay();
  const text = useText();
  const options = optionsOf(field.schema, useShowValue(field.labels));
  const control = useControls();
  const many = field.operator === "in";
  const choose = (next: string[]) => onChange(next, "choice");
  const semantics: Semantics = { id, label: name, invalid: false, required: false, disabled: false };
  switch (field.control) {
    case "options": {
      const OptionGroup = control("OptionGroup");
      return (
        <OptionGroup
          {...semantics}
          parts={{ root: "filter-options", option: "filter-option" }}
          multiple={many}
          options={options ?? []}
          value={many ? values : values.slice(0, 1)}
          onChange={choose}
        />
      );
    }
    case "toggle": {
      // On asks for the rows where it holds; off asks for nothing.
      const Switch = control("Switch");
      return <Switch {...semantics} part="filter-toggle" checked={values[0] === "true"} onChange={(checked) => choose(checked ? ["true"] : [])} />;
    }
    case "slider": {
      const Slider = control("Slider");
      const { minimum, maximum, multipleOf } = field.schema;
      return (
        <Slider
          {...semantics}
          label={name ?? text(field.label)}
          part="filter-slider"
          min={minimum}
          max={maximum}
          step={multipleOf ?? (plainTypes(field.schema).includes("integer") ? 1 : (maximum - minimum) / 100)}
          // At rest it sits at the bound that restricts nothing.
          value={values.length > 0 ? values[0] : String(field.operator === "lt" || field.operator === "lte" ? maximum : minimum)}
          valueText={values[0] ?? say("any")}
          onChange={(value) => onChange([value], "typed")}
          // Where it is let go is what applies.
          onCommit={onCommit}
        />
      );
    }
    case "tags": {
      const TagsInput = control("TagsInput");
      return (
        <TagsInput
          {...semantics}
          parts={{ root: "filter-tags", tag: "filter-tag", remove: "filter-tag-remove", input: "filter-input" }}
          type="text"
          values={values}
          removeLabels={values.map((value) => say("remove", { label: value }))}
          onChange={choose}
        />
      );
    }
    default:
      if (options && many) return <MultiSelectList {...semantics} part="filter-select" options={options} value={values} placeholder={say("any")} onChange={choose} />;
      if (options) {
        return (
          <SelectList
            {...semantics}
            part="filter-select"
            options={options}
            value={values[0] ?? ""}
            placeholder={say("any")}
            noneLabel={say("any")}
            onChange={(value) => choose(value === "" ? [] : [value])}
          />
        );
      }
      return <Typed field={field} id={id} name={name} values={values} onChange={onChange} onCommit={onCommit} />;
  }
}

/** A filter typed into. Under `in`, its values are separated by commas. */
function Typed({ field, id, name, values, onChange, onCommit }: FilterControlProps) {
  const { lang } = useContext(RendererContext);
  const control = useControls();
  const many = field.operator === "in";
  const parsed = (text: string) => (many ? separated(text) : text === "" ? [] : [text]);
  const [text, setText] = useState(values.join(", "));
  // Follow a value set from elsewhere — a reset, a preset — and leave what is
  // being typed alone while it still says the same.
  useEffect(() => {
    if (parsed(text).join("\n") !== values.join("\n")) setText(values.join(", "));
  }, [values.join("\n")]);
  const entry = {
    id,
    label: name,
    invalid: false,
    required: false,
    disabled: false,
    part: "filter-input" as const,
    value: text,
    onChange: (typed: string) => {
      setText(typed);
      onChange(parsed(typed), "typed");
    },
    onCommit,
  };
  if (!many && (plainTypes(field.schema).includes("number") || plainTypes(field.schema).includes("integer"))) {
    const NumberInput = control("NumberInput");
    return <NumberInput {...entry} integer={plainTypes(field.schema).includes("integer")} />;
  }
  if (!many && field.schema.format === "date") {
    const DateInput = control("DateInput");
    return <DateInput {...entry} lang={lang} />;
  }
  const TextInput = control("TextInput");
  return <TextInput {...entry} type="text" />;
}
