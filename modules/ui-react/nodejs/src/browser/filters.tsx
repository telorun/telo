import { X } from "lucide-react";
import { Label } from "radix-ui";
import { useContext, useId, useMemo, useState } from "react";
import { styleAttribute } from "./bindings.js";
import { filterParam, type Operator, type Param } from "./collection.js";
import { Icon } from "./icon.js";
import { Node, type SpecNode } from "./nodes.js";
import { FilterContext } from "./renderer-context.js";
import { MultiSelect, Select, type Option } from "./select.js";
import type { JsonSchema } from "./validation.js";

interface FilterField {
  property: string;
  operator: Operator;
  label: string;
  schema: JsonSchema;
}

type Chosen = string | string[];

const types = (schema: JsonSchema): string[] => [schema.type ?? []].flat();

function inputType(schema: JsonSchema): string {
  if (types(schema).includes("number") || types(schema).includes("integer")) return "number";
  if (schema.format === "date") return "date";
  return "text";
}

/** The parameters a field's chosen value sends; none when nothing is chosen. */
function paramsOf(field: FilterField, chosen: Chosen | undefined): Param[] {
  const values = (Array.isArray(chosen) ? chosen : (chosen ?? "").split(field.operator === "in" ? "," : "\n"))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return values.map((value) => filterParam(field.property, field.operator, value));
}

/** A filter bar: every table inside it obeys what is chosen here. */
export function Filters({ node }: { node: SpecNode }) {
  const id = useId();
  const outer = useContext(FilterContext);
  const fields = node.fields as FilterField[];
  const [chosen, setChosen] = useState<Record<number, Chosen>>({});
  // What is being typed into a field, until it is committed.
  const [typed, setTyped] = useState<Record<number, string>>({});
  const params = useMemo(
    () => [...outer, ...fields.flatMap((field, index) => paramsOf(field, chosen[index]))],
    [outer, fields, chosen],
  );
  return (
    <div data-telo-part="filters" data-state="idle" data-style={styleAttribute(node.style)}>
      {fields.map((field, index) => {
        const controlId = `${id}-${index}`;
        const set = (value: Chosen) => setChosen((current) => ({ ...current, [index]: value }));
        const entered = typed[index] ?? (chosen[index] as string | undefined) ?? "";
        // Typed text takes effect when it is committed, so the tables are asked
        // once for the value meant and not once per keystroke.
        const commit = () => {
          if (entered !== ((chosen[index] as string | undefined) ?? "")) set(entered);
        };
        const listed: unknown[] | undefined = Array.isArray(field.schema.enum)
          ? field.schema.enum
          : types(field.schema).includes("boolean")
            ? [true, false]
            : undefined;
        const options: Option[] | undefined = listed?.map((option) => ({
          value: String(option),
          label: typeof option === "boolean" ? (option ? "Yes" : "No") : String(option),
        }));
        return (
          <div key={index} data-telo-part="filter">
            <Label.Root data-telo-part="filter-label" htmlFor={controlId}>
              {field.label}
            </Label.Root>
            {options && field.operator === "in" ? (
              <MultiSelect
                part="filter-select"
                id={controlId}
                options={options}
                values={(chosen[index] as string[] | undefined) ?? []}
                placeholder="Any"
                onChange={set}
              />
            ) : options ? (
              <Select
                part="filter-select"
                id={controlId}
                options={options}
                value={(chosen[index] as string | undefined) ?? ""}
                placeholder="Any"
                none="Any"
                onChange={set}
              />
            ) : (
              <input
                data-telo-part="filter-input"
                id={controlId}
                type={field.operator === "in" ? "text" : inputType(field.schema)}
                value={entered}
                onChange={(event) => setTyped((current) => ({ ...current, [index]: event.target.value }))}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit();
                }}
              />
            )}
          </div>
        );
      })}
      <button
        data-telo-part="filters-reset"
        type="button"
        onClick={() => {
          setChosen({});
          setTyped({});
        }}
      >
        Reset
        <Icon of={X} />
      </button>
      <FilterContext.Provider value={params}>
        <Node node={node.content} />
      </FilterContext.Provider>
    </div>
  );
}
