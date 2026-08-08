import { parseToAst, readRefSlot, refSlotAnnotation, type AstDocument } from "@telorun/analyzer";
import type { ReplaceRange } from "../types.js";
import { resolveNodeAtPosition } from "./resolve-node.js";

export type { ReplaceRange };

export type CompletionCtx =
  | {
      type: "kind";
      /** Set for indented `kind:` lines. The enclosing docKind + the YAML
       *  path to the parent of the `kind:` field (so the value slot's
       *  schema node can be looked up to discover `x-telo-ref` constraints).
       *  Absent for top-level `kind:` — there, no constraint applies. */
      docKind?: string;
      yamlPath?: string[];
      /** Full source range of the kind value, so a pick overwrites the whole
       *  existing scalar (e.g. `Sql.Co|nnection` + `Sql.Connection` → no
       *  suffix left behind). */
      replaceRange: ReplaceRange;
    }
  | { type: "capability" }
  | { type: "prop-key"; docKind: string; yamlPath: string[]; existingKeys: Set<string> }
  | {
      /** Cursor sits on the value of an object-form ref's `name:` field
       *  (e.g. `connection: { kind: Sql.Connection, name: |}`). Editor hosts
       *  use `refKind` (from the sibling `kind:` line) to filter the in-doc
       *  resource list to matching candidates. */
      type: "ref-name";
      docKind: string;
      /** YAML path to the parent slot (e.g. `["connection"]`). The schema
       *  at this path declares the `x-telo-ref` constraint. */
      yamlPath: string[];
      /** The kind value of the sibling `kind:` line, if present. */
      refKind?: string;
      prefix: string;
      replaceRange: ReplaceRange;
    }
  | {
      type: "field-value";
      docKind: string;
      field: string;
      /** Text from the start of the value to the cursor. */
      prefix: string;
      /** Full source range of the value being completed. */
      replaceRange: ReplaceRange;
    };

/** Returns every schema branch reachable from `node` after peeling `anyOf` /
 *  `oneOf` recursively. A branch with no combinators is its own only entry.
 *  Used so an `x-telo-ref` slot like `{anyOf: [{type: string}, {type: object,
 *  properties: …}]}` exposes the object branch's properties to completion. */
function peelCombinators(node: Record<string, any>): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    const branches: any[] = [];
    if (Array.isArray(n.anyOf)) branches.push(...n.anyOf);
    if (Array.isArray(n.oneOf)) branches.push(...n.oneOf);
    if (branches.length === 0) {
      out.push(n);
      return;
    }
    for (const b of branches) visit(b);
  };
  visit(node);
  return out;
}

/** Navigate a JSON Schema hierarchy following `path`, auto-descending into
 *  array items and peeling `anyOf` / `oneOf` branches. When multiple peeled
 *  branches define `properties`, returns a synthetic node whose `properties`
 *  is the union (first-wins on key collision) and whose `required` is the
 *  intersection — enough for propKeyCompletions to surface every key a value
 *  at this slot can legally carry. */
export function navigateSchema(
  schema: Record<string, any>,
  path: string[],
): Record<string, any> | undefined {
  let current: Record<string, any> = schema;
  for (const segment of path) {
    const candidates = peelCombinators(current).flatMap((node) => {
      const expanded: Record<string, any>[] = [];
      let cur: Record<string, any> = node;
      while (cur.type === "array" && cur.items) cur = cur.items as Record<string, any>;
      for (const peeled of peelCombinators(cur)) expanded.push(peeled);
      return expanded;
    });
    let next: Record<string, any> | undefined;
    for (const cand of candidates) {
      const sub = (cand.properties as Record<string, any> | undefined)?.[segment];
      if (sub) {
        next = sub as Record<string, any>;
        break;
      }
    }
    if (!next) return undefined;
    current = next;
  }
  // Auto-descend through a trailing array at the leaf (e.g. cursor inside `mounts:` items)
  while (current.type === "array" && current.items) {
    current = current.items as Record<string, any>;
  }
  const leaves = peelCombinators(current);
  if (leaves.length === 1) return leaves[0];
  return unionLeaves(current, leaves);
}

/** Merge multiple peeled schema branches into one node for completion purposes.
 *  Property maps are unioned (first branch wins on key collision). `required`
 *  becomes the intersection so optional-in-any-branch keys still surface.
 *
 *  The parent's reference slot is re-stamped on the merged node, because peeling
 *  is exactly what destroys it: for the canonical multi-kind shape
 *  (`anyOf: [{x-telo-ref: A}, {x-telo-ref: B}]`) the constraint lives ONLY in the
 *  branches, and merging them left a node declaring no slot at all. Re-emitted
 *  through the analyzer's accessor so both annotation shapes survive the merge. */
function unionLeaves(
  parent: Record<string, any>,
  leaves: Record<string, any>[],
): Record<string, any> {
  const properties: Record<string, any> = {};
  const requiredSets: Set<string>[] = [];
  for (const leaf of leaves) {
    const props = leaf.properties as Record<string, any> | undefined;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (!(k in properties)) properties[k] = v;
      }
    }
    requiredSets.push(
      new Set(Array.isArray(leaf.required) ? (leaf.required as string[]) : []),
    );
  }
  let required: string[] = [];
  if (requiredSets.length > 0) {
    required = [...requiredSets[0]].filter((k) =>
      requiredSets.every((s) => s.has(k)),
    );
  }
  const out: Record<string, any> = { type: "object", properties, required };
  const slot = readRefSlot(parent);
  if (slot && slot.kinds.length > 0) out["x-telo-ref"] = refSlotAnnotation(slot);
  return out;
}

/** Walks up and down from `cursorLine` looking for a sibling line at the
 *  exact same indent whose key is `kind`. The value of the first such line
 *  is returned (alias form, e.g. `"Sql.Connection"`). Used by ref-name
 *  completion to discover what kind of resource the user is targeting in an
 *  object-form ref. Walking stops at the first line with a strictly smaller
 *  indent (that's the parent's structural boundary). */
/** Every kind the `x-telo-ref` slot at `yamlPath` accepts, or an empty array
 *  when the path doesn't resolve or declares no constraint.
 *
 *  All of them, not the first: a slot accepting `Invocable | Runnable` used to
 *  complete only the invocables, because a single-constraint lookup stopped at
 *  the first branch. The analyzer's accessor unions a `kind:` list and the
 *  `anyOf` / `oneOf` branches alike, so completion now offers what the slot
 *  actually takes. */
export function lookupRefConstraints(
  definitionSchema: Record<string, any>,
  yamlPath: string[],
): string[] {
  const node = navigateSchema(definitionSchema, yamlPath);
  if (!node) return [];
  return readRefSlot(node)?.kinds ?? [];
}

/** Derive a `CompletionCtx` from the AST-resolved cursor (Approach B). The
 *  structural resolution lives in `resolveNodeAtPosition`; this only maps a
 *  resolved slot onto the completion the editor should offer. `docs` lets a
 *  host thread its already-parsed AST; without it we parse locally so this
 *  stands alone. */
export function detectContext(
  text: string,
  line: number,
  character: number,
  docs?: AstDocument[],
): CompletionCtx | undefined {
  const resolved = resolveNodeAtPosition(text, docs ?? parseToAst(text), line, character);
  if (!resolved) return undefined;
  const { docKind } = resolved;

  if (resolved.slot === "value") {
    // Inside a CEL body — structural completion does not apply (a future
    // CEL-completion feature consumes `resolved.cel`).
    if (resolved.cel) return undefined;
    const replaceRange = resolved.replaceRange;
    if (!replaceRange) return undefined;
    const key = resolved.path[resolved.path.length - 1];
    const parentPath = resolved.path.slice(0, -1);
    const prefix = resolved.prefix ?? "";

    if (key === "kind") {
      if (parentPath.length === 0) return { type: "kind", replaceRange };
      if (docKind) return { type: "kind", docKind, yamlPath: parentPath, replaceRange };
      return undefined;
    }

    if (key === "capability" && docKind === "Telo.Definition") {
      return { type: "capability" };
    }

    // Any `name:` value is a candidate ref target; the sibling `kind:` (when
    // present) narrows the in-file resource list. Harmless on `metadata.name`,
    // where no ref constraint resolves and the list is the fallback.
    if (key === "name" && docKind) {
      return {
        type: "ref-name",
        docKind,
        yamlPath: parentPath,
        refKind: resolved.siblingKind,
        prefix,
        replaceRange,
      };
    }

    // Import-source: the scalar shorthand `imports.<Alias>` or the object-form
    // `imports.<Alias>.source`. `spaceAfterColon` distinguishes `Console: ` (a
    // value) from a bare `Tiny:` header about to carry a nested `source:`.
    if (
      (docKind === "Telo.Application" || docKind === "Telo.Library") &&
      resolved.spaceAfterColon
    ) {
      const isScalarEntry = parentPath.length === 1 && parentPath[0] === "imports";
      const isObjectSource =
        key === "source" && parentPath.length === 2 && parentPath[0] === "imports";
      if (isScalarEntry || isObjectSource) {
        return { type: "field-value", docKind, field: "import-source", prefix, replaceRange };
      }
    }

    return undefined;
  }

  // Key position (existing key, blank line, or trailing indent). Complete
  // against the nearest enclosing inline resource's schema (or the root
  // resource), with the path made relative to it — so a prop key inside
  // `mount: { kind: Crud.Resource, … }` offers Crud.Resource's fields, not the
  // outer ref slot's.
  const scopeKind = resolved.resourceKind ?? docKind;
  if (!scopeKind) return undefined;
  return {
    type: "prop-key",
    docKind: scopeKind,
    yamlPath: resolved.path.slice(resolved.resourceDepth ?? 0),
    existingKeys: resolved.existingKeys ?? new Set<string>(),
  };
}
