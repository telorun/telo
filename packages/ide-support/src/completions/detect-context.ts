export type CompletionCtx =
  | {
      type: "kind";
      /** Set for indented `kind:` lines. The enclosing docKind + the YAML
       *  path to the parent of the `kind:` field (so the value slot's
       *  schema node can be looked up to discover `x-telo-ref` constraints).
       *  Absent for top-level `kind:` — there, no constraint applies. */
      docKind?: string;
      yamlPath?: string[];
      /** Column where the kind value begins (after `kind:` + whitespace).
       *  Editor hosts use this to anchor the replace range so completions
       *  cleanly overwrite a kind that contains `.` (e.g. `Sql.Co|` →
       *  selecting `Sql.Connection` must replace `Sql.Co`, not just `Co`,
       *  which VS Code's default word range would). */
      valueStartColumn: number;
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
      valueStartColumn: number;
    }
  | {
      type: "field-value";
      docKind: string;
      field: string;
      /** Text from the start of the value to the cursor. */
      prefix: string;
      /** 0-based column where the value starts (right after `<field>:` + whitespace). */
      valueStartColumn: number;
    };

export function findDocBounds(lines: string[], cursorLine: number): { start: number; end: number } {
  let start = 0;
  for (let i = cursorLine; i >= 0; i--) {
    if (lines[i]?.trimEnd() === "---") {
      start = i + 1;
      break;
    }
  }
  let end = lines.length;
  for (let i = cursorLine + 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === "---") {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function extractKindFromDoc(lines: string[], start: number, end: number): string | undefined {
  for (let i = start; i < end; i++) {
    const m = lines[i]?.match(/^kind:\s*(\S+)/);
    if (m) return m[1];
  }
  return undefined;
}

/** Collects every top-level key in the doc bounds, skipping `skipLine` so the
 *  cursor's own line is treated as "being edited" — its key (if any) stays in
 *  the suggestion list. Without this the user can't autocomplete an existing
 *  key from its own line (e.g. `ver|sion:`). */
export function extractRootKeys(
  lines: string[],
  start: number,
  end: number,
  skipLine?: number,
): Set<string> {
  const keys = new Set<string>();
  for (let i = start; i < end; i++) {
    if (i === skipLine) continue;
    const m = lines[i]?.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Walk backward from cursorLine to build the chain of parent YAML keys.
 *
 *  List-item handling (`  - request:` style): the `-` marker sits at the
 *  line's textual indent, but the key after it (`request`) lives at indent
 *  `+2`. Whether that post-dash key joins the path depends on the cursor's
 *  descent:
 *    - When the cursor's current target indent is GREATER than the post-dash
 *      key's column, the descent passes through that key (e.g. cursor inside
 *      `request.method` at indent 6, key `request` at column 4) → push it.
 *    - When the cursor's current target indent EQUALS the post-dash key's
 *      column, the post-dash key is a sibling at the list-item level
 *      (e.g. cursor on `handler:` at indent 4, key `request:` at column 4) →
 *      skip it; descend straight to the array's parent.
 *
 *  In both cases the next walk step targets `lineIndent` so the `routes:` /
 *  `steps:` parent of the array is captured. The schema walker auto-descends
 *  arrays, so no `[]` marker is appended. */
export function buildYamlPath(
  lines: string[],
  cursorLine: number,
  docStart: number,
  cursorIndent: number,
): string[] {
  if (cursorIndent === 0) return [];

  const path: string[] = [];
  let targetIndent = cursorIndent;

  for (let i = cursorLine - 1; i >= docStart; i--) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const lineIndent = line.length - trimmed.length;
    if (lineIndent < targetIndent) {
      // Match a plain object key (not a list item marker)
      const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
      if (m) {
        path.unshift(m[1]);
        targetIndent = lineIndent;
        if (lineIndent === 0) break;
      } else if (trimmed.startsWith("- ")) {
        const postDash = trimmed.slice(2);
        const km = postDash.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
        const keyColumn = lineIndent + 2;
        if (km && keyColumn < targetIndent) {
          path.unshift(km[1]);
        }
        targetIndent = lineIndent;
      } else if (trimmed === "-") {
        targetIndent = lineIndent;
      } else {
        // Hit something we can't parse; stop
        break;
      }
    }
  }

  return path;
}

/** Extract sibling keys already present at `indent` within the doc bounds.
 *  `skipLine` lets the caller exclude the cursor's own line so a key being
 *  edited (`ver|sion:`) doesn't filter itself out of the suggestion list. */
export function extractKeysAtIndent(
  lines: string[],
  start: number,
  end: number,
  indent: number,
  skipLine?: number,
): Set<string> {
  const keys = new Set<string>();
  const prefix = " ".repeat(indent);
  for (let i = start; i < end; i++) {
    if (i === skipLine) continue;
    const line = lines[i] ?? "";
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(indent);
    const m = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (m && line.length - line.trimStart().length === indent) {
      keys.add(m[1]);
    }
  }
  return keys;
}

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
 *  `x-telo-ref` from the unpeeled parent is preserved so ref-aware lookups
 *  (`lookupRefConstraint`) still see the constraint when navigateSchema is
 *  called on a property that places the annotation alongside `anyOf`/`oneOf`. */
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
  if (typeof parent["x-telo-ref"] === "string") out["x-telo-ref"] = parent["x-telo-ref"];
  return out;
}

/** Walks up and down from `cursorLine` looking for a sibling line at the
 *  exact same indent whose key is `kind`. The value of the first such line
 *  is returned (alias form, e.g. `"Sql.Connection"`). Used by ref-name
 *  completion to discover what kind of resource the user is targeting in an
 *  object-form ref. Walking stops at the first line with a strictly smaller
 *  indent (that's the parent's structural boundary). */
export function findSiblingKindValue(
  lines: string[],
  docStart: number,
  docEnd: number,
  cursorLine: number,
  indent: number,
): string | undefined {
  const prefix = " ".repeat(indent);
  const scan = (range: number[]): string | undefined => {
    for (const i of range) {
      const line = lines[i] ?? "";
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (line.trimEnd() === "---") return undefined;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) return undefined; // parent boundary
      if (lineIndent !== indent || !line.startsWith(prefix)) continue;
      const m = line.slice(indent).match(/^kind:\s*(\S+)/);
      if (m) return m[1];
    }
    return undefined;
  };
  // Forward then backward — order doesn't matter for correctness because
  // any sibling kind value at this indent applies to the same object.
  const after = [];
  for (let i = cursorLine + 1; i < docEnd; i++) after.push(i);
  const before = [];
  for (let i = cursorLine - 1; i >= docStart; i--) before.push(i);
  return scan(after) ?? scan(before);
}

/** Looks up the `x-telo-ref` string carried by the schema node at `yamlPath`
 *  inside `definitionSchema`. Checks both the property node directly and its
 *  peeled `anyOf` / `oneOf` branches, since some library schemas place the
 *  annotation at the property level and others inside a branch. Returns
 *  `undefined` when the path doesn't resolve or no ref constraint is declared. */
export function lookupRefConstraint(
  definitionSchema: Record<string, any>,
  yamlPath: string[],
): string | undefined {
  const node = navigateSchema(definitionSchema, yamlPath);
  if (!node) return undefined;
  if (typeof node["x-telo-ref"] === "string") return node["x-telo-ref"];
  for (const branch of peelCombinators(node)) {
    if (typeof branch["x-telo-ref"] === "string") return branch["x-telo-ref"];
  }
  return undefined;
}

export function detectContext(
  text: string,
  line: number,
  character: number,
): CompletionCtx | undefined {
  const lines = text.split("\n");
  const currentLine = lines[line] ?? "";

  const { start, end } = findDocBounds(lines, line);
  const docKind = extractKindFromDoc(lines, start, end);

  // Kind value completion fires ONLY when the cursor sits past the `:` of a
  // `kind:` line. With the cursor on the key portion (start, middle, or right
  // before the colon) we fall through to prop-key completion so `kind` itself
  // can be suggested. Matches both top-level (`kind: …`) and indented forms;
  // indented form also surfaces the enclosing ref slot for filtering.
  const kindLineMatch = currentLine.match(/^(\s*)kind:(\s*)(\S*)$/);
  if (kindLineMatch) {
    const indent = kindLineMatch[1].length;
    const valueStart = indent + "kind:".length + kindLineMatch[2].length;
    if (character >= valueStart) {
      if (indent === 0) return { type: "kind", valueStartColumn: valueStart };
      if (docKind) {
        const yamlPath = buildYamlPath(lines, line, start, indent);
        return { type: "kind", docKind, yamlPath, valueStartColumn: valueStart };
      }
    }
    // Cursor is on the key portion — fall through to prop-key handling.
  }

  // Capability value completion: only inside Telo.Definition docs
  if (/^capability:\s*\S*$/.test(currentLine) && docKind === "Telo.Definition") {
    return { type: "capability" };
  }

  // Ref-name value completion: cursor on the value of a `name:` line inside
  // an object-form ref (sibling `kind:` declares which resource kind we're
  // referencing). The enclosing parent slot's schema carries the ref
  // constraint, but we don't need to consult it here — `buildCompletions`
  // will fall back to filtering by `refKind` regardless of the schema. Doing
  // so keeps editor autocomplete working even when the registry hasn't fully
  // resolved the resource's definition.
  const nameLineMatch = currentLine.match(/^(\s+)name:(\s*)(\S*)$/);
  if (nameLineMatch && docKind) {
    const indent = nameLineMatch[1].length;
    const valueStart = indent + "name:".length + nameLineMatch[2].length;
    const valuePrefix = nameLineMatch[3];
    if (character >= valueStart) {
      const yamlPath = buildYamlPath(lines, line, start, indent);
      // The yamlPath built here points at the parent slot — for
      // `connection: { kind: …, name: | }` the path is `["connection"]`.
      // The sibling `kind:` lives at the same indent as our `name:`, so we
      // scan the doc bounds for it.
      const refKind = findSiblingKindValue(lines, start, end, line, indent);
      return {
        type: "ref-name",
        docKind,
        yamlPath,
        refKind,
        prefix: valuePrefix,
        valueStartColumn: valueStart,
      };
    }
  }

  if (!docKind) return undefined;

  // Import-source value completion: entries in the `imports:` map on a module
  // doc. Two shapes are completed against filesystem paths / registry ids:
  //   scalar shorthand  `  Alias: <src>`     → the entry value IS the source
  //   object form       `    source: <src>`  → the `source:` under `imports.<Alias>`
  // Gated on the enclosing path resolving to the `imports:` map so unrelated
  // `source:` fields (e.g. `Assert.Manifest.source`) never trigger it.
  if (docKind === "Telo.Application" || docKind === "Telo.Library") {
    // Require a space after the colon (`key: …`) so a bare object-form header —
    // `  Tiny:` about to carry a nested `source:`/`variables:` — is treated as a
    // key position, not an import-source value. A flow-map (`Alias: { … }`) never
    // matches: `\S*` can't span the spaces inside the braces.
    const entryMatch = currentLine.match(/^(\s+)([A-Za-z_][\w-]*):(\s+)(\S*)$/);
    if (entryMatch) {
      const indent = entryMatch[1].length;
      const key = entryMatch[2];
      const valueStartColumn = indent + key.length + 1 + entryMatch[3].length;
      if (character >= valueStartColumn) {
        const parentPath = buildYamlPath(lines, line, start, indent);
        const isScalarEntry = parentPath.length === 1 && parentPath[0] === "imports";
        const isObjectSource =
          key === "source" && parentPath.length === 2 && parentPath[0] === "imports";
        if (isScalarEntry || isObjectSource) {
          const prefix = currentLine.slice(valueStartColumn, character);
          return { type: "field-value", docKind, field: "import-source", prefix, valueStartColumn };
        }
      }
    }
  }

  const trimmed = currentLine.trim();

  // Trigger when the cursor is on the KEY portion of the line. Three cases:
  //   1. Blank line / whitespace only — `existingKeys` skip means the user is
  //      starting a fresh key.
  //   2. Line has no `:` yet (e.g. `vers`, `version`) — partial key being typed.
  //   3. Line has `key: value` and the cursor is at or before the colon.
  //      The line text is preserved so `version|: 1.0.0` keeps suggesting keys
  //      while `version: |1.0.0` falls through to no completion.
  const colonIdx = currentLine.indexOf(":");
  const beforeColon = colonIdx === -1 ? currentLine : currentLine.slice(0, colonIdx);
  const isKeyLine =
    trimmed === "" ||
    (colonIdx === -1 && /^\s*[a-zA-Z_][a-zA-Z0-9_]*$/.test(currentLine)) ||
    (colonIdx !== -1 &&
      character <= colonIdx &&
      /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*$/.test(beforeColon));
  if (!isKeyLine) return undefined;

  // Indent resolution: for a whitespace-only line the cursor's column tells
  // us exactly where the user is about to type — VS Code parks the cursor at
  // the new auto-indent after Enter, and any deviation (backspace to col 0,
  // type extra spaces) is intentional. Trusting `character` also lets the
  // user reach root level (col 0) on a trailing blank line even when the
  // previous non-blank line was nested.
  const indent =
    trimmed === ""
      ? character
      : currentLine.length - currentLine.trimStart().length;

  if (indent === 0) {
    return {
      type: "prop-key",
      docKind,
      yamlPath: [],
      existingKeys: extractRootKeys(lines, start, end, line),
    };
  }

  const yamlPath = buildYamlPath(lines, line, start, indent);
  if (yamlPath.length === 0) return undefined; // couldn't resolve parent — bail

  const existingKeys = extractKeysAtIndent(lines, start, end, indent, line);
  return { type: "prop-key", docKind, yamlPath, existingKeys };
}
