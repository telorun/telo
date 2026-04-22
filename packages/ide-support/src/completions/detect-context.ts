export type CompletionCtx =
  | { type: "kind" }
  | { type: "capability" }
  | { type: "prop-key"; docKind: string; yamlPath: string[]; existingKeys: Set<string> };

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

export function extractRootKeys(lines: string[], start: number, end: number): Set<string> {
  const keys = new Set<string>();
  for (let i = start; i < end; i++) {
    const m = lines[i]?.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Walk backward from cursorLine to build the chain of parent YAML keys. */
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
      } else {
        // Hit something we can't parse (e.g. a list item `- ...`); stop
        break;
      }
    }
  }

  return path;
}

/** Extract sibling keys already present at `indent` within the doc bounds. */
export function extractKeysAtIndent(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): Set<string> {
  const keys = new Set<string>();
  const prefix = " ".repeat(indent);
  for (let i = start; i < end; i++) {
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

/** Navigate a JSON Schema hierarchy following `path`, auto-descending into array items. */
export function navigateSchema(
  schema: Record<string, any>,
  path: string[],
): Record<string, any> | undefined {
  let current = schema;
  for (const segment of path) {
    // Auto-descend through arrays before looking up the next key
    while (current.type === "array" && current.items) {
      current = current.items as Record<string, any>;
    }
    const props = current.properties as Record<string, any> | undefined;
    if (!props?.[segment]) return undefined;
    current = props[segment] as Record<string, any>;
  }
  // Auto-descend through a trailing array at the leaf (e.g. cursor inside `mounts:` items)
  while (current.type === "array" && current.items) {
    current = current.items as Record<string, any>;
  }
  return current;
}

/**
 * For blank lines (and lines with only whitespace), infer the intended indent
 * from context rather than relying on the cursor column, which is often 0
 * even when the cursor is semantically inside a nested block.
 *
 * Strategy: look at the previous non-empty line.
 *   - If it ends with `:` (bare object key, no value) → cursor is one level deeper.
 *   - Otherwise → cursor is a sibling of that key (same indent).
 */
export function inferIndentForBlankLine(lines: string[], cursorLine: number, docStart: number): number {
  for (let i = cursorLine - 1; i >= docStart; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.trimEnd() === "---") break;
    const lineIndent = line.length - line.trimStart().length;
    if (line.trimEnd().endsWith(":")) {
      return lineIndent + 2;
    }
    return lineIndent;
  }
  return 0;
}

export function detectContext(
  text: string,
  line: number,
  character: number,
): CompletionCtx | undefined {
  const lines = text.split("\n");
  const currentLine = lines[line] ?? "";

  // Kind value completion: `kind: ` or `kind: SomePrefix`
  if (/^kind:\s*\S*$/.test(currentLine)) {
    return { type: "kind" };
  }

  const { start, end } = findDocBounds(lines, line);
  const docKind = extractKindFromDoc(lines, start, end);

  // Capability value completion: only inside Telo.Definition docs
  if (/^capability:\s*\S*$/.test(currentLine) && docKind === "Telo.Definition") {
    return { type: "capability" };
  }

  if (!docKind) return undefined;

  const trimmed = currentLine.trim();

  // Only trigger when the line looks like a key being typed (or is blank)
  const isKeyLine = trimmed === "" || /^[a-zA-Z_][a-zA-Z0-9_]*:?$/.test(trimmed);
  if (!isKeyLine) return undefined;

  const indent =
    trimmed === ""
      ? inferIndentForBlankLine(lines, line, start)
      : currentLine.length - currentLine.trimStart().length;

  if (indent === 0) {
    return { type: "prop-key", docKind, yamlPath: [], existingKeys: extractRootKeys(lines, start, end) };
  }

  const yamlPath = buildYamlPath(lines, line, start, indent);
  if (yamlPath.length === 0) return undefined; // couldn't resolve parent — bail

  const existingKeys = extractKeysAtIndent(lines, start, end, indent);
  return { type: "prop-key", docKind, yamlPath, existingKeys };
}
