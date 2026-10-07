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
 *       x-telo-browser-export: { entry: /entry }
 * ```
 *
 * The annotated string names an EXPORT of a browser entry, and `entry` is a JSON
 * Pointer — relative to the object holding the annotated field — to the sibling
 * string naming that entry's `specifier`. The entry is one the module that
 * DECLARED THE RESOURCE lists under `exports.browser`: a resource names code its
 * own module ships, which is what `ctx.resolveBrowserEntry` then resolves.
 *
 * `telo check` (`BROWSER_ENTRY_UNKNOWN` / `BROWSER_EXPORT_UNKNOWN`) and the
 * kernel's refusal at creation (`ERR_BROWSER_ENTRY_UNKNOWN` /
 * `ERR_BROWSER_EXPORT_UNKNOWN`) both read this file. It names no kind.
 *
 * Browser-safe: no Node built-ins.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";
import type { BrowserEntry } from "./module-browser.js";

export const BROWSER_EXPORT_ANNOTATION = "x-telo-browser-export";

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
}

/** A value the annotation refuses, in the wording both halves share. */
export interface BrowserExportProblem {
  code: "BROWSER_ENTRY_UNKNOWN" | "BROWSER_EXPORT_UNKNOWN";
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

const declaring = new WeakMap<object, boolean>();

/** True when `schema` writes the annotation anywhere — asked before a resource
 *  is walked, since almost no kind does. Memoized per schema object. */
function declaresBrowserExport(schema: Record<string, any>): boolean {
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
  if (!declaresBrowserExport(schema)) return [];
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

    const segments = pointerSegments(declared[BROWSER_EXPORT_ANNOTATION]?.entry);
    if (segments && holder && !out.has(path)) {
      let specifier: unknown = holder.value;
      for (const segment of segments) {
        specifier = isPlainObject(specifier) ? specifier[segment] : undefined;
      }
      out.set(path, {
        path,
        entryPath: [holder.path, ...segments].filter((part) => part !== "").join("."),
        exportName: value,
        specifier,
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

/**
 * What is wrong with each site, against the browser entries of the module that
 * declared the resource. A site whose entry name or export name is not a
 * decided string — absent, or still an expression — is left alone: the schema
 * says whether it may be absent, and the kernel judges it once it has a value.
 */
export function browserExportProblems(
  sites: readonly BrowserExportSite[],
  entries: readonly BrowserEntry[],
): BrowserExportProblem[] {
  const out: BrowserExportProblem[] = [];
  for (const site of sites) {
    if (typeof site.specifier !== "string" || typeof site.exportName !== "string") continue;
    const entry = entries.find((candidate) => candidate.specifier === site.specifier);
    if (!entry) {
      out.push({
        code: "BROWSER_ENTRY_UNKNOWN",
        path: site.entryPath,
        message:
          `'${site.entryPath}: ${site.specifier}' names no browser entry of the module declaring ` +
          `this resource. ` +
          (entries.length > 0
            ? `It declares ${entries.map((e) => `'${e.specifier}'`).join(", ")} under exports.browser.`
            : `It declares none — add the entry under exports.browser on the module doc.`),
      });
      continue;
    }
    if (!entry.exports.includes(site.exportName)) {
      out.push({
        code: "BROWSER_EXPORT_UNKNOWN",
        path: site.path,
        message:
          `'${site.path}: ${site.exportName}' is not an export the browser entry ` +
          `'${entry.specifier}' declares. ` +
          (entry.exports.length > 0
            ? `It declares ${entry.exports.map((name) => `'${name}'`).join(", ")}.`
            : `It declares none — list the name under the entry's 'exports'.`),
      });
    }
  }
  return out;
}
