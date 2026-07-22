import {
  parseToAst,
  type AnalysisRegistry,
  type AstDocument,
} from "@telorun/analyzer";
import type { HoverResult } from "../types.js";
import { navigateSchema } from "../completions/detect-context.js";
import {
  resolveNodeAtPosition,
  scalarString,
  type ResolvedCursor,
} from "../completions/resolve-node.js";
import { CAPABILITY_DOCS } from "../completions/valid-capabilities.js";

type Definition = NonNullable<ReturnType<AnalysisRegistry["resolveDefinition"]>>;

/** Docs for the structural keys shared by every module doc, so hover is useful
 *  even at the root, where there is no user-authored schema to navigate. */
const STRUCTURAL_KEY_DOCS: Record<string, string> = {
  kind: "The resource kind — `Alias.Name` for an imported kind, or a `Telo.*` root kind.",
  metadata: "Resource identity: `name` (kebab-case, dot-free) and optional `namespace`.",
  imports: "Dependency map: PascalCase alias → `namespace/name@version` source string or object.",
  targets: "Boot sequence run after init — references to `Runnable`/`Service` resources or inline invoke steps.",
  variables: "Typed inputs bound from host env vars (`env:` + JSON-Schema `type:`).",
  secrets: "Secret inputs bound from host env vars (`env:` + `type:`).",
  ports: "Inbound ports the app listens on, each bound to a host env var (Application only).",
  exports: "What importers may reference: `kinds` (kind gate) and `resources` (instance singletons).",
  include: "Partial files loaded into this module scope (paths / globs).",
  capability: "The lifecycle role of the kind this definition registers.",
  schema: "JSON Schema for the kind's config fields, with `x-telo-*` annotations.",
  extends: "Alias-form kind this definition specializes (abstract contract or concrete parent).",
  base: "Construction mapping (`super(...)`) over `self` for a concrete-`extends` definition.",
  controllers: "Controller locator (`pkg:npm`) implementing this kind.",
};

/** The kind value of the map that directly encloses `keyName` in the value slot. */
function typeName(t: string | Record<string, any> | undefined): string | undefined {
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof t.title === "string") return t.title;
  return undefined;
}

function kindHover(kind: string, def: Definition | undefined): string {
  if (!def) return `\`${kind}\``;
  const lines: string[] = [`### ${kind}`];
  const role = def.capability ? `\`${def.capability}\`` : "resource";
  const module = def.metadata?.module ? ` · module \`${def.metadata.module}\`` : "";
  lines.push(`${role}${module}`);
  const schema = def.schema as Record<string, any> | undefined;
  const desc = schema?.description ?? schema?.title;
  if (typeof desc === "string" && desc) lines.push("", desc);
  if (def.extends) lines.push("", `Extends \`${def.extends}\``);
  const input = typeName(def.inputType);
  const output = typeName(def.outputType);
  if (input) lines.push(`Input \`${input}\``);
  if (output) lines.push(`Output \`${output}\``);
  return lines.join("\n");
}

function fieldHover(keyName: string, field: Record<string, any>): string {
  const lines: string[] = [];
  const type = Array.isArray(field.type) ? field.type.join(" | ") : field.type;
  const head = type ? `**${keyName}**: \`${type}\`` : `**${keyName}**`;
  lines.push(head);
  if (typeof field.description === "string" && field.description) {
    lines.push("", field.description);
  }
  const ref = field["x-telo-ref"];
  if (typeof ref === "string") lines.push("", `Reference → \`${ref}\``);
  if (Array.isArray(field.enum) && field.enum.length > 0) {
    lines.push("", `Allowed: ${field.enum.map((v: unknown) => `\`${v}\``).join(", ")}`);
  }
  if (field.default !== undefined) lines.push(`Default: \`${JSON.stringify(field.default)}\``);
  return lines.length > 0 ? lines.join("\n") : `**${keyName}**`;
}

/** Field schema at the nearest enclosing resource, or undefined when the scope
 *  can't be resolved (no kind-bearing ancestor, or the path doesn't navigate). */
function fieldSchemaFor(
  resourceKind: string | undefined,
  relativePath: string[],
  registry: AnalysisRegistry | undefined,
): Record<string, any> | undefined {
  if (!resourceKind || !registry) return undefined;
  const def = registry.resolveDefinition(resourceKind);
  if (!def?.schema) return undefined;
  return navigateSchema(def.schema as Record<string, any>, relativePath);
}

export function buildHover(
  text: string,
  line: number,
  character: number,
  registry: AnalysisRegistry | undefined,
  docs?: AstDocument[],
): HoverResult | undefined {
  const astDocs = docs ?? parseToAst(text);
  const resolved = resolveNodeAtPosition(text, astDocs, line, character);
  if (!resolved) return undefined;

  if (resolved.slot === "value") return hoverForValue(resolved, registry);
  return hoverForKey(resolved, registry);
}

function hoverForValue(
  resolved: ResolvedCursor,
  registry: AnalysisRegistry | undefined,
): HoverResult | undefined {
  const key = resolved.path[resolved.path.length - 1];
  const value = scalarString(resolved.node);
  const range = resolved.replaceRange;

  if (key === "kind" && value) {
    return { contents: kindHover(value, registry?.resolveDefinition(value)), range };
  }
  if (key === "capability" && resolved.docKind === "Telo.Definition" && value) {
    const doc = CAPABILITY_DOCS[value];
    return doc ? { contents: `**${value}**\n\n${doc}`, range } : undefined;
  }

  // Field value: describe the field via the enclosing resource's schema. Works
  // when the value sits directly under a kind-bearing map (`siblingKind`); the
  // field path relative to that map is just the key.
  if (key) {
    const field = fieldSchemaFor(resolved.siblingKind, [key], registry);
    if (field) return { contents: fieldHover(key, field), range };
  }
  return undefined;
}

function hoverForKey(
  resolved: ResolvedCursor,
  registry: AnalysisRegistry | undefined,
): HoverResult | undefined {
  const keyName = scalarString(resolved.node);
  if (!keyName) return undefined;
  const range = resolved.replaceRange;

  const resourceKind = resolved.resourceKind ?? resolved.docKind;
  const relativePath = [...resolved.path.slice(resolved.resourceDepth ?? 0), keyName];
  const field = fieldSchemaFor(resourceKind, relativePath, registry);
  if (field) return { contents: fieldHover(keyName, field), range };

  const structural = STRUCTURAL_KEY_DOCS[keyName];
  if (structural && relativePath.length === 1) {
    return { contents: `**${keyName}**\n\n${structural}`, range };
  }
  return undefined;
}
