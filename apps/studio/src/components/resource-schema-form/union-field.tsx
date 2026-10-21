import { selectUnionBranch } from "@telorun/analyzer";
import { useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import type { RefResolver } from "./ref-candidates";
import { buildEditorDefaultValue } from "./default-value";
import { inferType } from "./field-control";
import { resolveLocalSchemaRef } from "./local-schema-ref";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

/**
 * A field whose value is one of several SHAPES — `anyOf` / `oneOf` with no
 * `type` or `properties` of its own, so no single control can draw it: a text
 * that is a string or an object, a value that is a constant or a path.
 *
 * Its branches are read through every reference and every nested union of the
 * same kind, so a union holding a union offers the leaves side by side. Which
 * branch a value is written against is the analyzer's rule
 * (`selectUnionBranch`); the author may pick another, which rewrites the value
 * to that branch's default.
 */

function isTypelessUnion(node: JsonSchemaProperty): boolean {
  if (node.type !== undefined || node.properties !== undefined) return false;
  return Array.isArray(node.anyOf) || Array.isArray(node.oneOf);
}

/** The shapes a union admits, nested unions flattened; empty when `prop` is not
 *  a union of two or more shapes. */
export function unionBranches(
  prop: JsonSchemaProperty,
  root: Record<string, unknown> | undefined,
): JsonSchemaProperty[] {
  if (!isTypelessUnion(prop)) return [];
  const out: JsonSchemaProperty[] = [];
  const open = new Set<object | string>();
  const visit = (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    // A resolved `$ref` is a fresh object on every call, so a self-referencing union is tracked by its reference.
    const ref = (raw as { $ref?: unknown }).$ref;
    const key = typeof ref === "string" ? ref : raw;
    const node = resolveLocalSchemaRef(raw as JsonSchemaProperty, root);
    if (isTypelessUnion(node) && !open.has(key)) {
      open.add(key);
      for (const branch of (node.anyOf ?? node.oneOf) as unknown[]) visit(branch);
      return;
    }
    out.push(node);
  };
  for (const branch of (prop.anyOf ?? prop.oneOf) as unknown[]) visit(branch);
  return out.length >= 2 ? out : [];
}

/** What a branch is called in the picker: its title, else its constant, else the
 *  members an object of it must hold, else its type. */
export function branchLabel(branch: JsonSchemaProperty): string {
  if (typeof branch.title === "string") return branch.title;
  if ("const" in branch) return JSON.stringify(branch.const);
  if (inferType(branch) === "object" && Array.isArray(branch.required) && branch.required.length) {
    return branch.required.join(", ");
  }
  return typeof branch.type === "string" ? branch.type : "value";
}

/** The kind a value has in JSON Schema's vocabulary. */
function valueKind(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

/** The branch the analyzer selects for `value`, or -1 when none fits alone. */
function selectedIndex(
  branches: JsonSchemaProperty[],
  value: unknown,
  root: Record<string, unknown> | undefined,
): number {
  const selected = selectUnionBranch({ anyOf: branches }, value, root ?? {});
  return branches.indexOf(selected as JsonSchemaProperty);
}

/** The branch `value` is written against: the one the analyzer selects, else the
 *  first whose type admits the value, else the first. */
export function branchIndexOf(
  branches: JsonSchemaProperty[],
  value: unknown,
  root: Record<string, unknown> | undefined,
): number {
  const selected = selectedIndex(branches, value, root);
  if (selected !== -1) return selected;
  const kind = valueKind(value);
  const admitting = branches.findIndex(
    (branch) => branch.type === kind || (branch.type === "integer" && kind === "number"),
  );
  return admitting === -1 ? 0 : admitting;
}

/** True when the chosen branch draws fields of its own beneath it. */
export function branchDescends(branch: JsonSchemaProperty): boolean {
  const kind = inferType(branch);
  return kind === "object" || kind === "array";
}

interface UnionFieldProps {
  branches: JsonSchemaProperty[];
  value: unknown;
  onValueChange: (next: unknown) => void;
  root: Record<string, unknown> | undefined;
  resolvedResources: ResolvedResourceOption[];
  registry?: RefResolver | null;
  /** Draws the chosen branch's own control for the same value. */
  renderBranch: (branch: JsonSchemaProperty) => ReactNode;
}

export function UnionField({
  branches,
  value,
  onValueChange,
  root,
  resolvedResources,
  registry,
  renderBranch,
}: UnionFieldProps) {
  // A value no branch selects alone (an object just switched to, with nothing
  // in it yet) keeps the branch the author picked.
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const fitting = selectedIndex(branches, value, root);
  const active = fitting !== -1 ? fitting : (picked ?? branchIndexOf(branches, value, root));

  function pick(index: number) {
    if (index === active) return;
    setPicked(index);
    const branch = branches[index];
    onValueChange(
      "const" in branch
        ? branch.const
        : buildEditorDefaultValue(branch, resolvedResources, registry),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Tabs value={String(active)} onValueChange={(next) => pick(Number(next))}>
        <TabsList>
          {branches.map((branch, index) => (
            <TabsTrigger key={index} value={String(index)} className="px-2 text-xs">
              {branchLabel(branch)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {renderBranch(branches[active])}
    </div>
  );
}
