/**
 * `x-telo-application-source` — the annotation's single reader.
 *
 * ```yaml
 * schema:
 *   properties:
 *     source:
 *       type: string
 *       x-telo-application-source:
 *         variables: /variables
 *         secrets: /secrets
 *         ports: /ports
 *         needs: /needs
 * ```
 *
 * The annotated string names the source of a CHILD APPLICATION the resource
 * runs, and each key names the child's declaration block a sibling map of the
 * resource feeds, as a JSON Pointer from the resource root. The keys are the
 * child's own block names, so which map supplies which block is written in the
 * annotation and never read off a field's name.
 *
 * Three readers share this file: the loader, which follows each such source as a
 * child-application edge so an analysis holds the child's declarations
 * (`applicationSourceFieldOf`, `applicationSourceCandidates`); the analysis pass that
 * holds the maps to them (`readApplicationSourceSlot`, `validate-application-
 * inputs.ts`); and the annotation's strict half
 * (`applicationSourceAnnotationProblems`, `APPLICATION_SOURCE_ANNOTATION_INVALID`).
 * It names no kind: the loader resolves a written kind through the declaring
 * module's import edges.
 *
 * Browser-safe: no Node built-ins.
 */

import { kindDeclarationOf } from "./kind-declaration.js";
import { kindDocumentIn, type LoadedKindScope } from "./loaded-kind-scope.js";
import type { LoadedModule } from "./loaded-types.js";

export const APPLICATION_SOURCE_ANNOTATION = "x-telo-application-source";

/** The child's declaration blocks a resource may feed, in the order they are read. */
export const APPLICATION_INPUT_BLOCKS = ["variables", "secrets", "ports", "needs"] as const;
export type ApplicationInputBlock = (typeof APPLICATION_INPUT_BLOCKS)[number];

/** The annotation as read off a kind's schema. */
export interface ApplicationSourceSlot {
  /** The top-level property holding the child's source. */
  field: string;
  /** Per child block, the keys of the resource field that feeds it. */
  feeds: Partial<Record<ApplicationInputBlock, readonly string[]>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function pointerSegments(pointer: unknown): string[] | undefined {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/") return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.every((segment) => segment !== "") ? segments : undefined;
}

/** The feeds a well-formed annotation value names; a malformed part is read as
 *  absent, so nothing beyond the strict half's own refusal follows. */
function readFeeds(raw: unknown): ApplicationSourceSlot["feeds"] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const feeds: ApplicationSourceSlot["feeds"] = {};
  for (const block of APPLICATION_INPUT_BLOCKS) {
    const segments = pointerSegments(raw[block]);
    if (segments) feeds[block] = segments;
  }
  return feeds;
}

/**
 * The annotation a kind's schema writes on one of its named top-level
 * properties, or undefined. Any other placement is refused by the strict half
 * and read as none here.
 */
export function readApplicationSourceSlot(schema: unknown): ApplicationSourceSlot | undefined {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return undefined;
  for (const [field, property] of Object.entries(schema.properties)) {
    if (!isPlainObject(property) || !(APPLICATION_SOURCE_ANNOTATION in property)) continue;
    const feeds = readFeeds(property[APPLICATION_SOURCE_ANNOTATION]);
    if (feeds) return { field, feeds };
  }
  return undefined;
}

/** The value at `keys` beneath `holder`, or undefined. */
export function valueAtKeys(holder: unknown, keys: readonly string[]): unknown {
  let value = holder;
  for (const key of keys) {
    if (!isPlainObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

// --- The loader's half ------------------------------------------------------

/**
 * The field holding a child application's source for a resource of `kind`
 * written in `mod`, or undefined: the kind resolved through `mod`'s own import
 * edges to the kind document declaring it (`kindDocumentIn`, read through
 * `kindDeclarationOf`), annotated there or inherited from the parent its merge
 * form `extends` — resolved in the declaring module's scope. A `base:` child's
 * author schema is its own, so it inherits no annotation.
 */
export function applicationSourceFieldOf(
  graph: LoadedKindScope,
  mod: LoadedModule,
  kind: string,
  seen: Set<object> = new Set(),
): string | undefined {
  const found = kindDocumentIn(graph, mod, kind);
  if (!found || seen.has(found.doc)) return undefined;
  seen.add(found.doc);
  const definition = kindDeclarationOf(found.doc) as
    | { schema?: unknown; extends?: unknown; base?: unknown }
    | undefined;
  if (!definition) return undefined;
  const slot = readApplicationSourceSlot(definition.schema);
  if (slot) return slot.field;
  if (typeof definition.extends !== "string" || definition.base !== undefined) return undefined;
  return applicationSourceFieldOf(graph, found.module, definition.extends, seen);
}

/**
 * Every literal source written at the annotated field of a resource in
 * `manifests` — a top-level declaration, a scope member or an inline one, at any
 * depth — `fieldOf` answering which field a written kind holds it in. A computed
 * value is not a source the loader can follow and is left to the analysis.
 */
export function applicationSourceCandidates(
  manifests: Iterable<unknown>,
  fieldOf: (kind: string) => string | undefined,
): Set<string> {
  const out = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isPlainObject(node)) return;
    if (typeof node.kind === "string") {
      const field = fieldOf(node.kind);
      const source = field !== undefined ? node[field] : undefined;
      if (typeof source === "string" && source !== "") out.add(source);
    }
    for (const value of Object.values(node)) visit(value);
  };
  for (const manifest of manifests) visit(manifest);
  return out;
}

// --- The strict half --------------------------------------------------------

/** A malformed annotation, where the kind document writes it. */
export interface ApplicationSourceAnnotationProblem {
  /** `schema.properties.source.x-telo-application-source.needs`. */
  path: string;
  message: string;
}

/** The schema keywords whose values hold schemas, as maps or as lists. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_VALUES = [
  "additionalProperties",
  "items",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
] as const;
const SCHEMA_LISTS = ["oneOf", "anyOf", "allOf", "items"] as const;

const SHAPE =
  `The annotation is { variables?, secrets?, ports?, needs? }, each a JSON Pointer from the ` +
  `resource root to the map that feeds that block of the child application.`;

const quoted = (names: readonly string[]) => names.map((name) => `'${name}'`).join(", ");

/** Whether `keys` names a property the schema declares, through `properties`. */
function declaresProperty(schema: Record<string, unknown>, keys: readonly string[]): boolean {
  let node: unknown = schema;
  for (const key of keys) {
    if (!isPlainObject(node) || !isPlainObject(node.properties) || !(key in node.properties)) {
      return false;
    }
    node = node.properties[key];
  }
  return true;
}

/**
 * Every annotation a kind's `schema` writes that the readers above cannot honour:
 * one placed anywhere but a named top-level property, a second one, a value that
 * is not `{ variables?, secrets?, ports?, needs? }` of JSON Pointers to distinct
 * properties the schema declares, and a field that is not a literal string — an
 * annotated field marked `x-telo-eval` would hold a source computed at run time,
 * which nothing can follow before the child starts. `at` is where the schema sits
 * in the kind document.
 */
export function applicationSourceAnnotationProblems(
  kind: string,
  schema: unknown,
  at: readonly (string | number)[] = ["schema"],
): ApplicationSourceAnnotationProblem[] {
  const problems: ApplicationSourceAnnotationProblem[] = [];
  const render = (path: readonly (string | number)[]) =>
    path.reduce<string>(
      (out, segment) =>
        typeof segment === "number" ? `${out}[${segment}]` : out === "" ? segment : `${out}.${segment}`,
      "",
    );
  const refuse = (path: readonly (string | number)[], detail: string) => {
    const where = render(path);
    problems.push({ path: where, message: `'${kind}' declares '${where}': ${detail}` });
  };
  const root = isPlainObject(schema) ? schema : undefined;
  let annotated: string | undefined;

  const judge = (
    property: Record<string, unknown>,
    path: readonly (string | number)[],
    field: string | undefined,
  ) => {
    const annotationPath = [...path, APPLICATION_SOURCE_ANNOTATION];
    if (field === undefined) {
      refuse(
        annotationPath,
        `the annotation belongs on a named top-level property of the kind's schema — the field ` +
          `holding the source of the one application the resource runs.`,
      );
      return;
    }
    if (annotated !== undefined) {
      refuse(
        annotationPath,
        `'${annotated}' already names this kind's child application. A resource runs one ` +
          `application, so the annotation is written once.`,
      );
      return;
    }
    annotated = field;
    if (property.type !== "string") {
      refuse(
        [...path, "type"],
        `the annotated field holds the child application's source and must declare 'type: string'.`,
      );
    }
    if ("x-telo-eval" in property) {
      refuse(
        [...path, "x-telo-eval"],
        `the child application's source must be a literal: a source computed at run time cannot ` +
          `be resolved, pinned or checked before the application starts. Remove 'x-telo-eval'.`,
      );
    }
    const raw = property[APPLICATION_SOURCE_ANNOTATION];
    if (!isPlainObject(raw)) {
      refuse(annotationPath, `it must be an object. ${SHAPE}`);
      return;
    }
    const unknown = Object.keys(raw).filter(
      (key) => !(APPLICATION_INPUT_BLOCKS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      refuse(
        annotationPath,
        `${unknown.length === 1 ? "key" : "keys"} ${quoted(unknown)} ${unknown.length === 1 ? "is" : "are"} ` +
          `read by nothing. Known: ${APPLICATION_INPUT_BLOCKS.join(", ")}.`,
      );
    }
    const targets = new Map<string, string>();
    for (const block of APPLICATION_INPUT_BLOCKS) {
      if (raw[block] === undefined) continue;
      const blockPath = [...annotationPath, block];
      const segments = pointerSegments(raw[block]);
      if (!segments) {
        refuse(
          blockPath,
          `'${block}' must be a JSON Pointer ('/<field>') from the resource root to the map ` +
            `that feeds the child's '${block}:'.`,
        );
        continue;
      }
      const pointer = raw[block] as string;
      if (segments.length === 1 && segments[0] === field) {
        refuse(blockPath, `'${pointer}' is the source field itself, not a map of inputs.`);
        continue;
      }
      if (root && !declaresProperty(root, segments)) {
        refuse(blockPath, `'${pointer}' names no property this kind's schema declares.`);
        continue;
      }
      const other = targets.get(pointer);
      if (other) {
        refuse(blockPath, `'${pointer}' already feeds '${other}'; each block is fed by a map of its own.`);
        continue;
      }
      targets.set(pointer, block);
    }
  };

  const seen = new Set<object>();
  const visit = (node: unknown, path: readonly (string | number)[], field?: string) => {
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    if (APPLICATION_SOURCE_ANNOTATION in node) judge(node, path, field);
    for (const key of SCHEMA_MAPS) {
      if (isPlainObject(node[key])) {
        for (const [name, child] of Object.entries(node[key] as Record<string, unknown>)) {
          visit(child, [...path, key, name], node === root && key === "properties" ? name : undefined);
        }
      }
    }
    for (const key of SCHEMA_VALUES) visit(node[key], [...path, key]);
    for (const key of SCHEMA_LISTS) {
      if (Array.isArray(node[key])) (node[key] as unknown[]).forEach((child, i) => visit(child, [...path, key, i]));
    }
  };
  visit(schema, at);
  return problems;
}
