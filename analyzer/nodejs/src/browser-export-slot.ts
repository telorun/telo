/**
 * `x-telo-browser-export` — the annotation's single reader.
 *
 * ```yaml
 * component:
 *   type: object
 *   properties:
 *     entry: { type: string }
 *     export:
 *       type: string
 *       x-telo-browser-export:
 *         entry: /entry
 *         abi: [ui-1]
 *         external: [react, react/jsx-runtime]
 * ```
 *
 * The annotated string names an EXPORT of a browser entry, and `entry` is a JSON
 * Pointer — relative to the object holding the annotated field — to the sibling
 * string naming that entry's `specifier`. The entry is one the module that
 * DECLARED THE RESOURCE lists under `exports.browser`: a resource names code its
 * own module ships, which is what `ctx.resolveBrowserEntry` then resolves.
 *
 * `abi` lists the generations the declaring kind accepts, `external` the bare
 * specifiers it supplies; each, when written, is held against the named entry's
 * own `abi` and `external`.
 *
 * `telo check` (`BROWSER_ENTRY_UNKNOWN`, `BROWSER_ENTRY_ABI_UNSUPPORTED`,
 * `BROWSER_ENTRY_IMPORT_UNSUPPLIED`, `BROWSER_EXPORT_UNKNOWN`) and the kernel's
 * refusal at creation (each `ERR_`-prefixed) both read this file, as do the
 * annotation's strict half (`BROWSER_EXPORT_ANNOTATION_INVALID` at the kind,
 * `ERR_BROWSER_EXPORT_ANNOTATION_INVALID` at definition registration). It names
 * no kind.
 *
 * Browser-safe: no Node built-ins.
 */
import { AXIS_VALUE_FORMS } from "./artifact-axes.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import type { BrowserEntry } from "./module-browser.js";

export const BROWSER_EXPORT_ANNOTATION = "x-telo-browser-export";

const ANNOTATION_KEYS = ["entry", "abi", "external"] as const;
const ABI_FORM = AXIS_VALUE_FORMS.abi!;

/** One annotated value of a resource, with the entry name written beside it. */
export interface BrowserExportSite {
  /** Concrete path of the annotated value (`cells[0].component.export`). */
  path: string;
  /** Concrete path of the sibling naming the entry. */
  entryPath: string;
  /** What is written at each — a string once decided, anything else when the
   *  value is absent or still an expression. */
  exportName: unknown;
  specifier: unknown;
  /** The generations the kind accepts, when its annotation lists them. */
  abi?: readonly string[];
  /** The specifiers the kind supplies, when its annotation lists them. */
  external?: readonly string[];
}

/** A value the annotation refuses, in the wording both halves share. */
export interface BrowserExportProblem {
  code:
    | "BROWSER_ENTRY_UNKNOWN"
    | "BROWSER_ENTRY_ABI_UNSUPPORTED"
    | "BROWSER_ENTRY_IMPORT_UNSUPPLIED"
    | "BROWSER_EXPORT_UNKNOWN";
  path: string;
  message: string;
}

/** A malformed annotation, where the kind document writes it. */
export interface BrowserExportAnnotationProblem {
  /** `schema.properties.export.x-telo-browser-export.abi`. */
  path: string;
  message: string;
}

function pointerSegments(pointer: unknown): string[] | undefined {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isAbi = (value: unknown): value is string => typeof value === "string" && ABI_FORM.pattern.test(value);
const isSpecifier = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** What `abi` must be: a non-empty list of `<family>-<version>`. */
function abiListProblem(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0 && value.every(isAbi)) return undefined;
  return (
    `'abi' must be a non-empty list of the generations the kind accepts, each of the form ` +
    `${ABI_FORM.form} (${ABI_FORM.examples.map((e) => `'${e}'`).join(", ")}).`
  );
}

/** What `external` must be: a list of non-empty bare specifiers. */
function externalListProblem(value: unknown): string | undefined {
  if (Array.isArray(value) && value.every(isSpecifier)) return undefined;
  return `'external' must be a list of the bare specifiers the kind supplies, each a non-empty string.`;
}

/** The annotation as the sites read it. Lenient: a part the strict half
 *  refuses is read as absent, so nothing beyond its own refusal follows. */
function readAnnotation(
  raw: unknown,
): { entry: string[]; abi?: readonly string[]; external?: readonly string[] } | undefined {
  if (!isPlainObject(raw)) return undefined;
  const entry = pointerSegments(raw.entry);
  if (!entry) return undefined;
  return {
    entry,
    ...(raw.abi !== undefined && abiListProblem(raw.abi) === undefined ? { abi: raw.abi as string[] } : {}),
    ...(raw.external !== undefined && externalListProblem(raw.external) === undefined
      ? { external: (raw.external as string[]).map((name) => name.trim()) }
      : {}),
  };
}

const declaring = new WeakMap<object, boolean>();

/** True when `schema` writes the annotation anywhere — asked before a resource
 *  is walked, since almost no kind does. Memoized per schema object. */
export function schemaDeclaresBrowserExport(schema: Record<string, any>): boolean {
  let known = declaring.get(schema);
  if (known === undefined) {
    const seen = new Set<object>();
    const scan = (node: unknown): boolean => {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) return node.some(scan);
      return BROWSER_EXPORT_ANNOTATION in node || Object.values(node).some(scan);
    };
    declaring.set(schema, (known = scan(schema)));
  }
  return known;
}

/**
 * Every annotated value `data` holds, found by walking `schema` and the value in
 * tandem: through `properties`, a map's `additionalProperties`, a list's
 * `items`, every `oneOf` / `anyOf` / `allOf` branch and a document-local `$ref`.
 */
export function browserExportSites(schema: Record<string, any>, data: unknown): BrowserExportSite[] {
  if (!schemaDeclaresBrowserExport(schema)) return [];
  const out = new Map<string, BrowserExportSite>();
  const entered = new Set<string>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const nodeId = (node: object) => {
    let id = ids.get(node);
    if (id === undefined) ids.set(node, (id = nextId++));
    return id;
  };

  const walk = (
    node: unknown,
    value: unknown,
    path: string,
    holder: { value: Record<string, unknown>; path: string } | undefined,
  ): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || value === undefined) return;
    const declared = node as Record<string, any>;
    const key = `${nodeId(declared)}\0${path}`;
    if (entered.has(key)) return;
    entered.add(key);

    const annotation = readAnnotation(declared[BROWSER_EXPORT_ANNOTATION]);
    if (annotation && holder && !out.has(path)) {
      let specifier: unknown = holder.value;
      for (const segment of annotation.entry) {
        specifier = isPlainObject(specifier) ? specifier[segment] : undefined;
      }
      out.set(path, {
        path,
        entryPath: [holder.path, ...annotation.entry].filter((part) => part !== "").join("."),
        exportName: value,
        specifier,
        ...(annotation.abi ? { abi: annotation.abi } : {}),
        ...(annotation.external ? { external: annotation.external } : {}),
      });
    }

    if (typeof declared.$ref === "string" && declared.$ref.startsWith("#")) {
      walk(resolveSchemaPointer(schema, declared.$ref), value, path, holder);
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(declared[union])) {
        for (const branch of declared[union]) walk(branch, value, path, holder);
      }
    }
    if (Array.isArray(value)) {
      if (declared.items && typeof declared.items === "object" && !Array.isArray(declared.items)) {
        value.forEach((item, index) => walk(declared.items, item, `${path}[${index}]`, holder));
      }
      return;
    }
    if (!isPlainObject(value)) return;
    const properties = isPlainObject(declared.properties) ? declared.properties : {};
    const here = { value, path };
    for (const [name, child] of Object.entries(value)) {
      const childPath = path === "" ? name : `${path}.${name}`;
      if (name in properties) walk(properties[name], child, childPath, here);
      else if (declared.additionalProperties && typeof declared.additionalProperties === "object") {
        walk(declared.additionalProperties, child, childPath, here);
      }
    }
  };
  walk(schema, data, "", undefined);
  return [...out.values()];
}

const quoted = (names: readonly string[]) => names.map((name) => `'${name}'`).join(", ");

/**
 * What is wrong with each site, against the browser entries of the module that
 * declared the resource. A site whose entry name or export name is not a
 * decided string — absent, or still an expression — is left alone: the schema
 * says whether it may be absent, and the kernel judges it once it has a value.
 * A named entry is judged for its generation, its imports and the export, each
 * on its own.
 */
export function browserExportProblems(
  sites: readonly BrowserExportSite[],
  entries: readonly BrowserEntry[],
): BrowserExportProblem[] {
  const out: BrowserExportProblem[] = [];
  // A problem with the named entry is one finding at its field, however many sites name it.
  const reported = new Set<string>();
  const push = (problem: BrowserExportProblem) => {
    const key = `${problem.code}\0${problem.path}`;
    if (reported.has(key)) return;
    reported.add(key);
    out.push(problem);
  };
  for (const site of sites) {
    if (typeof site.specifier !== "string" || typeof site.exportName !== "string") continue;
    const entry = entries.find((candidate) => candidate.specifier === site.specifier);
    if (!entry) {
      push({
        code: "BROWSER_ENTRY_UNKNOWN",
        path: site.entryPath,
        message:
          `'${site.entryPath}: ${site.specifier}' names no browser entry of the module declaring ` +
          `this resource. ` +
          (entries.length > 0
            ? `It declares ${quoted(entries.map((e) => e.specifier))} under exports.browser.`
            : `It declares none — add the entry under exports.browser on the module doc.`),
      });
      continue;
    }
    if (site.abi && (entry.abi === undefined || !site.abi.includes(entry.abi))) {
      push({
        code: "BROWSER_ENTRY_ABI_UNSUPPORTED",
        path: site.entryPath,
        message:
          `'${site.entryPath}: ${site.specifier}' names a browser entry ` +
          (entry.abi === undefined ? `that declares no 'abi'` : `written against '${entry.abi}'`) +
          `, and this field accepts ${quoted(site.abi)}. Name an entry written against one of ` +
          `them — its 'abi' says which host contract it was built for.`,
      });
    }
    if (site.external) {
      const unsupplied = entry.external.filter((name) => !site.external!.includes(name));
      if (unsupplied.length > 0) {
        push({
          code: "BROWSER_ENTRY_IMPORT_UNSUPPLIED",
          path: site.entryPath,
          message:
            `'${site.entryPath}: ${site.specifier}' names a browser entry that leaves ` +
            `${quoted(unsupplied)} to its host (its 'external'), and this field supplies ` +
            (site.external.length > 0 ? `only ${quoted(site.external)}` : `none`) +
            `. Bundle ${unsupplied.length === 1 ? "it" : "them"} into the entry by removing ` +
            `${unsupplied.length === 1 ? "it" : "them"} from 'external', or name an entry that ` +
            `imports only what is supplied.`,
        });
      }
    }
    if (!entry.exports.includes(site.exportName)) {
      push({
        code: "BROWSER_EXPORT_UNKNOWN",
        path: site.path,
        message:
          `'${site.path}: ${site.exportName}' is not an export the browser entry ` +
          `'${entry.specifier}' declares. ` +
          (entry.exports.length > 0
            ? `It declares ${quoted(entry.exports)}.`
            : `It declares none — list the name under the entry's 'exports'.`),
      });
    }
  }
  return out;
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

/**
 * Every annotation a kind's `schema` writes whose shape is not
 * `{ entry: <JSON Pointer>, abi?: [<family>-<version>…], external?: [<specifier>…] }`,
 * found by walking the schema's own nodes. `at` is where the schema sits in the
 * kind document.
 */
export function browserExportAnnotationProblems(
  kind: string,
  schema: unknown,
  at: readonly (string | number)[] = ["schema"],
): BrowserExportAnnotationProblem[] {
  const problems: BrowserExportAnnotationProblem[] = [];
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
  const judge = (raw: unknown, path: readonly (string | number)[]) => {
    const shape = `The annotation is { entry: <JSON Pointer>, abi?: [<generation>…], external?: [<specifier>…] }.`;
    if (!isPlainObject(raw)) {
      refuse(path, `it must be an object. ${shape}`);
      return;
    }
    const unknown = Object.keys(raw).filter((key) => !(ANNOTATION_KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) {
      refuse(
        path,
        `${unknown.length === 1 ? "key" : "keys"} ${quoted(unknown)} ${unknown.length === 1 ? "is" : "are"} ` +
          `read by nothing. Known: ${ANNOTATION_KEYS.join(", ")}.`,
      );
    }
    if (!pointerSegments(raw.entry)) {
      refuse(
        [...path, "entry"],
        `'entry' must be a JSON Pointer ('/<field>'), relative to the object holding the annotated ` +
          `field, to the sibling string naming the browser entry's specifier.`,
      );
    }
    if (raw.abi !== undefined) {
      const detail = abiListProblem(raw.abi);
      if (detail) refuse([...path, "abi"], detail);
    }
    if (raw.external !== undefined) {
      const detail = externalListProblem(raw.external);
      if (detail) refuse([...path, "external"], detail);
    }
  };
  const seen = new Set<object>();
  const visit = (node: unknown, path: readonly (string | number)[]) => {
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    if (BROWSER_EXPORT_ANNOTATION in node) judge(node[BROWSER_EXPORT_ANNOTATION], [...path, BROWSER_EXPORT_ANNOTATION]);
    for (const key of SCHEMA_MAPS) {
      if (isPlainObject(node[key])) {
        for (const [name, child] of Object.entries(node[key] as Record<string, unknown>)) {
          visit(child, [...path, key, name]);
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
