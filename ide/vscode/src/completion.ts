import type { AnalysisRegistry } from "@telorun/analyzer";
import * as vscode from "vscode";

const CAPABILITY_VALUES = [
  "Telo.Service",
  "Telo.Runnable",
  "Telo.Invocable",
  "Telo.Provider",
  "Telo.Mount",
  "Telo.Type",
];

// Abstract/template kinds that should not appear as resource kind suggestions
const ABSTRACT_DEF_KINDS = new Set(["Telo.Abstract", "Telo.Template"]);

type CompletionCtx =
  | { type: "kind" }
  | { type: "capability" }
  | { type: "prop-key"; docKind: string; yamlPath: string[]; existingKeys: Set<string> };

function findDocBounds(lines: string[], cursorLine: number): { start: number; end: number } {
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

function extractKindFromDoc(lines: string[], start: number, end: number): string | undefined {
  for (let i = start; i < end; i++) {
    const m = lines[i]?.match(/^kind:\s*(\S+)/);
    if (m) return m[1];
  }
  return undefined;
}

function extractRootKeys(lines: string[], start: number, end: number): Set<string> {
  const keys = new Set<string>();
  for (let i = start; i < end; i++) {
    const m = lines[i]?.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Walk backward from cursorLine to build the chain of parent YAML keys. */
function buildYamlPath(
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
function extractKeysAtIndent(
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
function navigateSchema(
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
 * from context rather than relying on `position.character`, which is often 0
 * even when the cursor is semantically inside a nested block.
 *
 * Strategy: look at the previous non-empty line.
 *   - If it ends with `:` (bare object key, no value) → cursor is one level deeper.
 *   - Otherwise → cursor is a sibling of that key (same indent).
 */
function inferIndentForBlankLine(lines: string[], cursorLine: number, docStart: number): number {
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

function detectContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): CompletionCtx | undefined {
  const lines = document.getText().split("\n");
  const currentLine = lines[position.line] ?? "";

  // Kind value completion: `kind: ` or `kind: SomePrefix`
  if (/^kind:\s*\S*$/.test(currentLine)) {
    return { type: "kind" };
  }

  const { start, end } = findDocBounds(lines, position.line);
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
      ? inferIndentForBlankLine(lines, position.line, start)
      : currentLine.length - currentLine.trimStart().length;

  if (indent === 0) {
    return { type: "prop-key", docKind, yamlPath: [], existingKeys: extractRootKeys(lines, start, end) };
  }

  const yamlPath = buildYamlPath(lines, position.line, start, indent);
  if (yamlPath.length === 0) return undefined; // couldn't resolve parent — bail

  const existingKeys = extractKeysAtIndent(lines, start, end, indent);
  return { type: "prop-key", docKind, yamlPath, existingKeys };
}

export class TeloCompletionProvider implements vscode.CompletionItemProvider {
  private readonly registries = new Map<string, AnalysisRegistry>();

  updateRegistry(filePath: string, registry: AnalysisRegistry): void {
    this.registries.set(filePath, registry);
  }

  deleteRegistry(filePath: string): void {
    this.registries.delete(filePath);
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (document.languageId !== "yaml") return undefined;

    const ctx = detectContext(document, position);
    if (!ctx) return undefined;

    const registry = this.registries.get(document.uri.fsPath);

    if (ctx.type === "kind") return kindCompletions(registry);
    if (ctx.type === "capability") return capabilityCompletions();
    if (ctx.type === "prop-key") {
      return propKeyCompletions(ctx.docKind, ctx.yamlPath, ctx.existingKeys, registry);
    }

    return undefined;
  }
}

function kindCompletions(registry: AnalysisRegistry | undefined): vscode.CompletionItem[] {
  const kinds = new Set<string>([
    "Telo.Application",
    "Telo.Library",
    "Telo.Import",
    "Telo.Definition",
  ]);

  if (registry) {
    for (const kind of registry.allKinds()) {
      const def = registry.resolveDefinition(kind);
      if (def && !ABSTRACT_DEF_KINDS.has(def.kind)) {
        kinds.add(kind);
      }
    }
  }

  return Array.from(kinds).map((kind) => {
    const item = new vscode.CompletionItem(kind, vscode.CompletionItemKind.Class);
    item.detail = "Telo resource kind";
    return item;
  });
}

function capabilityCompletions(): vscode.CompletionItem[] {
  return CAPABILITY_VALUES.map((cap) => {
    const item = new vscode.CompletionItem(cap, vscode.CompletionItemKind.EnumMember);
    item.detail = "Telo capability";
    return item;
  });
}

function propKeyCompletions(
  kind: string,
  yamlPath: string[],
  existingKeys: Set<string>,
  registry: AnalysisRegistry | undefined,
): vscode.CompletionItem[] {
  if (!registry) return [];

  const definition = registry.resolveDefinition(kind);
  if (!definition?.schema) return [];

  const targetSchema = yamlPath.length === 0
    ? definition.schema
    : navigateSchema(definition.schema, yamlPath);

  if (!targetSchema?.properties) return [];

  const required = new Set<string>(
    Array.isArray(targetSchema.required) ? targetSchema.required : [],
  );
  const items: vscode.CompletionItem[] = [];

  for (const [prop, propSchema] of Object.entries(
    targetSchema.properties as Record<string, any>,
  )) {
    if (existingKeys.has(prop)) continue;
    if (yamlPath.length === 0 && (prop === "kind" || prop === "metadata")) continue;

    const item = new vscode.CompletionItem(prop, vscode.CompletionItemKind.Property);
    item.insertText = new vscode.SnippetString(`${prop}: $0`);

    const parts: string[] = [];
    if (propSchema.type) parts.push(propSchema.type);
    if (propSchema.default !== undefined) parts.push(`default: ${JSON.stringify(propSchema.default)}`);
    if (parts.length) item.detail = parts.join("  ");
    if (propSchema.description) item.documentation = propSchema.description;

    if (required.has(prop)) {
      item.preselect = true;
      item.sortText = `0_${prop}`;
    } else {
      item.sortText = `1_${prop}`;
    }

    items.push(item);
  }

  return items;
}
