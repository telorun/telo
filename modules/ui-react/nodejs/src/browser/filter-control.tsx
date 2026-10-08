import { Slider, Switch, ToggleGroup } from "radix-ui";
import { useEffect, useState } from "react";
import type { FilterField } from "./filter-state.js";
import { OptionGroup, Tags, separated } from "./list-controls.js";
import { MultiSelect, Select, type Option } from "./select.js";
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

function inputType(field: FilterField): string {
  if (field.operator === "in") return "text";
  if (plainTypes(field.schema).includes("number") || plainTypes(field.schema).includes("integer")) return "number";
  if (field.schema.format === "date") return "date";
  return "text";
}

/** What a filter is chosen from: its property's listed values, or yes and no. */
function optionsOf(schema: JsonSchema): Option[] | undefined {
  const listed: unknown[] | undefined = Array.isArray(schema.enum) ? schema.enum : plainTypes(schema).includes("boolean") ? [true, false] : undefined;
  return listed?.map((option) => ({
    value: String(option),
    label: typeof option === "boolean" ? (option ? "Yes" : "No") : String(option),
  }));
}

/** One filter's control, as its field says it is entered. */
export function FilterControl({ field, id, name, values, onChange, onCommit }: FilterControlProps) {
  const options = optionsOf(field.schema);
  const many = field.operator === "in";
  const choose = (next: string[]) => onChange(next, "choice");
  switch (field.control) {
    case "options":
      return many ? (
        <OptionGroup parts={{ group: "filter-options", option: "filter-option" }} id={id} name={name} options={options ?? []} values={values} onChange={choose} />
      ) : (
        <ToggleGroup.Root
          data-telo-part="filter-options"
          id={id}
          type="single"
          aria-label={name}
          value={values[0] ?? ""}
          onValueChange={(value) => choose(value === "" ? [] : [value])}
        >
          {options?.map((option) => (
            <ToggleGroup.Item key={option.value} data-telo-part="filter-option" value={option.value}>
              {option.label}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      );
    case "toggle":
      // On asks for the rows where it holds; off asks for nothing.
      return (
        <Switch.Root
          data-telo-part="filter-toggle"
          id={id}
          aria-label={name}
          checked={values[0] === "true"}
          onCheckedChange={(checked) => choose(checked ? ["true"] : [])}
        />
      );
    case "slider": {
      const { minimum, maximum, multipleOf } = field.schema;
      return (
        <Slider.Root
          data-telo-part="filter-slider"
          id={id}
          min={minimum}
          max={maximum}
          step={multipleOf ?? (plainTypes(field.schema).includes("integer") ? 1 : (maximum - minimum) / 100)}
          // At rest it sits at the bound that restricts nothing.
          value={[values.length > 0 ? Number(values[0]) : field.operator === "lt" || field.operator === "lte" ? maximum : minimum]}
          onValueChange={([value]) => onChange([String(value)], "typed")}
          // The primitive reports where it was let go before it reports the move.
          onValueCommit={([value]) => choose([String(value)])}
        >
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumb aria-label={name ?? field.label} aria-valuetext={values[0] ?? "Any"} />
        </Slider.Root>
      );
    }
    case "tags":
      return (
        <Tags
          parts={{ tags: "filter-tags", tag: "filter-tag", remove: "filter-tag-remove", input: "filter-input" }}
          id={id}
          name={name}
          values={values}
          onChange={choose}
        />
      );
    default:
      if (options && many) return <MultiSelect part="filter-select" id={id} options={options} values={values} placeholder="Any" onChange={choose} />;
      if (options) {
        return (
          <Select
            part="filter-select"
            id={id}
            options={options}
            value={values[0] ?? ""}
            placeholder="Any"
            none="Any"
            onChange={(value) => choose(value === "" ? [] : [value])}
          />
        );
      }
      return <Typed field={field} id={id} name={name} values={values} onChange={onChange} onCommit={onCommit} />;
  }
}

/** A filter typed into. Under `in`, its values are separated by commas. */
function Typed({ field, id, name, values, onChange, onCommit }: FilterControlProps) {
  const many = field.operator === "in";
  const parsed = (text: string) => (many ? separated(text) : text === "" ? [] : [text]);
  const [text, setText] = useState(values.join(", "));
  // Follow a value set from elsewhere — a reset, a preset — and leave what is
  // being typed alone while it still says the same.
  useEffect(() => {
    if (parsed(text).join("\n") !== values.join("\n")) setText(values.join(", "));
  }, [values.join("\n")]);
  return (
    <input
      data-telo-part="filter-input"
      id={id}
      aria-label={name}
      autoComplete="off"
      type={inputType(field)}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parsed(event.target.value), "typed");
      }}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit();
      }}
    />
  );
}
