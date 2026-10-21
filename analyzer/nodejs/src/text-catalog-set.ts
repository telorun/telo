/**
 * `x-telo-text-catalog-set: true` — the one reader of a kind's catalog sets, for
 * `telo check` and the kernel alike.
 *
 * The annotation, on a node of a kind's `schema:`, says the catalogs at and
 * beneath it form ONE lookup set: every `TextCatalog` value written there, and
 * every catalog in the configuration of each declaration a reference there
 * names — continuing through the catalog sets that declaration's own kind marks.
 * Membership is by declaration, so a catalog reached twice is one member. Set
 * order is written order, a reference expanded where it is written.
 *
 * What it refuses:
 *
 * - at the kind, a node whose value is not `true` (`SCHEMA_VIOLATION`), a node
 *   reaching neither a `TextCatalog` nor a reference slot, and a node nested under
 *   another marked one (`TEXT_CATALOG_SET_INVALID`);
 * - at a resource of the kind, one text and context translated twice in one
 *   language across the set's catalogs (`MESSAGE_ENTRY_DUPLICATE`), reported at the
 *   holder's reference — or inline catalog — that brings in the later one. Two
 *   entries inside one catalog are that catalog's own finding.
 *
 * Duplicates are keyed by the message core's identity, so a nested source and a
 * plain one, or `{ $n }` and `{$n}`, are one text. Linear in the set's entries.
 *
 * The walk is host-neutral: the analyzer resolves references through its
 * projection scope, the kernel through the instances it created.
 * Browser-safe: no Node built-ins.
 */
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { isRefSlot } from "./ref-slot.js";
import { judgeCatalog } from "./text-judgement.js";
import {
  pointerSegments,
  renderValuePath,
  safeRegExp,
  siteValueOf,
  TEXT_CATALOG_FRAGMENT,
  textFragmentOf,
  textSites,
  type ValuePath,
} from "./text-slot.js";

export const TEXT_CATALOG_SET_ANNOTATION = "x-telo-text-catalog-set";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A named shape resolved, with the document its own `#…` references resolve against. */
export type NamedShapeResolver = (ref: string) => { schema: Schema; root: Schema } | undefined;

export interface TextCatalogSetProblem {
  readonly code: "SCHEMA_VIOLATION" | "TEXT_CATALOG_SET_INVALID";
  /** Where the annotation is written, from the kind document. */
  readonly path: string;
  readonly message: string;
}

/** The schemas beneath a node, each with the keys leading to it. */
function childSchemas(node: Schema): { keys: (string | number)[]; schema: Schema }[] {
  const out: { keys: (string | number)[]; schema: Schema }[] = [];
  for (const map of ["properties", "patternProperties"] as const) {
    if (isSchema(node[map])) {
      for (const [key, child] of Object.entries(node[map])) if (isSchema(child)) out.push({ keys: [map, key], schema: child });
    }
  }
  if (isSchema(node.additionalProperties)) out.push({ keys: ["additionalProperties"], schema: node.additionalProperties });
  if (isSchema(node.items)) out.push({ keys: ["items"], schema: node.items });
  for (const union of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[union])) {
      node[union].forEach((branch: unknown, index: number) => {
        if (isSchema(branch)) out.push({ keys: [union, index], schema: branch });
      });
    }
  }
  return out;
}

/** True when a catalog fragment or a reference slot lies at or beneath `node`. */
function reachesMember(node: Schema, root: Schema, resolveRef: NamedShapeResolver | undefined, seen: Set<object>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (textFragmentOf(node) === TEXT_CATALOG_FRAGMENT || isRefSlot(node)) return true;
  if (typeof node.$ref === "string") {
    if (node.$ref.startsWith("#")) {
      const target = resolveSchemaPointer(root, node.$ref);
      if (isSchema(target) && reachesMember(target, root, resolveRef, seen)) return true;
    } else {
      const named = resolveRef?.(node.$ref);
      if (named && reachesMember(named.schema, named.root, resolveRef, seen)) return true;
    }
  }
  return childSchemas(node).some(({ schema }) => reachesMember(schema, root, resolveRef, seen));
}

const declaring = new WeakMap<object, boolean>();

/** True when a kind's schema marks a catalog set anywhere. Memoized. */
export function declaresTextCatalogSet(schema: unknown): boolean {
  if (!isSchema(schema)) return false;
  let known = declaring.get(schema);
  if (known === undefined) {
    const seen = new Set<object>();
    const scan = (node: unknown): boolean => {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) return node.some(scan);
      if (TEXT_CATALOG_SET_ANNOTATION in node) return true;
      return Object.values(node).some(scan);
    };
    declaring.set(schema, (known = scan(schema)));
  }
  return known;
}

/**
 * Every misplaced or malformed catalog set of a kind. `schema` is its
 * configuration schema, `at` where that is written in the kind document;
 * document-local references are followed, a named shape through `resolveRef`.
 */
export function textCatalogSetProblems(
  kind: string,
  schema: unknown,
  resolveRef?: NamedShapeResolver,
  at: ValuePath = ["schema"],
): TextCatalogSetProblem[] {
  if (!isSchema(schema) || !declaresTextCatalogSet(schema)) return [];
  const problems: TextCatalogSetProblem[] = [];
  const reported = new Set<object>();
  const visit = (node: Schema, path: ValuePath, within: string | undefined, open: readonly string[]): void => {
    let enclosing = within;
    if (TEXT_CATALOG_SET_ANNOTATION in node && !reported.has(node)) {
      reported.add(node);
      const where = renderValuePath([...path, TEXT_CATALOG_SET_ANNOTATION]);
      if (node[TEXT_CATALOG_SET_ANNOTATION] !== true) {
        problems.push({
          code: "SCHEMA_VIOLATION",
          path: where,
          message: `'${kind}' declares '${where}' as ${JSON.stringify(node[TEXT_CATALOG_SET_ANNOTATION])}: a catalog set is marked with true alone`,
        });
      } else if (within !== undefined) {
        problems.push({
          code: "TEXT_CATALOG_SET_INVALID",
          path: where,
          message:
            `'${kind}' marks '${where}' as a catalog set inside the catalog set '${within}', which already ` +
            `holds everything beneath it: remove the inner mark`,
        });
      } else if (!reachesMember(node, schema, resolveRef, new Set())) {
        problems.push({
          code: "TEXT_CATALOG_SET_INVALID",
          path: where,
          message:
            `'${kind}' marks '${where}' as a catalog set, and nothing at or beneath it is a text catalog or a ` +
            `reference: mark the field holding the catalogs, or the references naming them`,
        });
      }
      if (within === undefined) enclosing = where;
    }
    if (typeof node.$ref === "string" && node.$ref.startsWith("#") && !open.includes(node.$ref)) {
      const target = resolveSchemaPointer(schema, node.$ref);
      if (isSchema(target)) {
        visit(target, [...at, ...(pointerSegments(node.$ref.slice(1)) ?? [])], enclosing, [...open, node.$ref]);
      }
    }
    for (const child of childSchemas(node)) visit(child.schema, [...path, ...child.keys], enclosing, open);
  };
  visit(schema, at, undefined, []);
  return problems;
}

/**
 * Where a resource's value meets a marked node: the outermost places, in written
 * order. A value an expression produces is no place — what it holds is not known.
 */
export function textCatalogSetRegions(
  schema: Schema,
  data: unknown,
  isExpression: (value: unknown) => boolean,
  resolveRef?: NamedShapeResolver,
): ValuePath[] {
  if (!declaresTextCatalogSet(schema)) return [];
  const found = new Map<string, ValuePath>();
  const entered = new Set<string>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (node: object) => {
    let id = ids.get(node);
    if (id === undefined) ids.set(node, (id = next++));
    return id;
  };
  const walk = (node: unknown, root: Schema, value: unknown, path: ValuePath): void => {
    if (!isSchema(node) || value === undefined || isExpression(value)) return;
    const rendered = renderValuePath(path);
    const key = `${idOf(node)}\0${rendered}`;
    if (entered.has(key)) return;
    entered.add(key);
    if (node[TEXT_CATALOG_SET_ANNOTATION] === true) {
      if (![...found.keys()].some((outer) => isWithin(rendered, outer))) found.set(rendered, path);
      return;
    }
    if (typeof node.$ref === "string") {
      if (node.$ref.startsWith("#")) walk(resolveSchemaPointer(root, node.$ref), root, value, path);
      else {
        const named = resolveRef?.(node.$ref);
        if (named) walk(named.schema, named.root, value, path);
      }
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(node[union])) for (const branch of node[union]) walk(branch, root, value, path);
    }
    if (Array.isArray(value)) {
      if (isSchema(node.items)) value.forEach((item, index) => walk(node.items, root, item, [...path, index]));
      return;
    }
    if (!isPlainObject(value)) return;
    const properties = isSchema(node.properties) ? node.properties : {};
    const patterns = isSchema(node.patternProperties) ? node.patternProperties : {};
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) {
        walk(properties[name], root, child, [...path, name]);
        continue;
      }
      let matched = false;
      for (const [pattern, patternSchema] of Object.entries(patterns)) {
        if (safeRegExp(pattern)?.test(name)) {
          matched = true;
          walk(patternSchema, root, child, [...path, name]);
        }
      }
      if (!matched && isSchema(node.additionalProperties)) walk(node.additionalProperties, root, child, [...path, name]);
    }
  };
  walk(schema, schema, data, []);
  const regions = [...found.values()];
  regions.sort((a, b) => comparePaths(data, a, b));
  return regions;
}

const isWithin = (rendered: string, outer: string): boolean =>
  outer === "" || rendered === outer || rendered.startsWith(`${outer}.`) || rendered.startsWith(`${outer}[`);

const startsWith = (path: ValuePath, prefix: ValuePath): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

/** Written order of two places in `root`: list items by index, object members by
 *  the order they were written in. */
function comparePaths(root: unknown, a: ValuePath, b: ValuePath): number {
  let at: unknown = root;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left !== right) {
      if (typeof left === "number" && typeof right === "number") return left - right;
      const keys = isPlainObject(at) ? Object.keys(at) : [];
      return keys.indexOf(String(left)) - keys.indexOf(String(right));
    }
    at = Array.isArray(at) ? at[left as number] : isPlainObject(at) ? at[left as string] : undefined;
  }
  return a.length - b.length;
}

/** A reference site of a declaration: where it is, and what it holds. */
export interface CatalogSetReferenceSite {
  readonly keys: ValuePath;
  readonly data: unknown;
}

/** What walking a catalog set reads from its host. `D` is a declaration, as the
 *  host holds one. */
export interface TextCatalogSetHost<D> {
  readonly isExpression: (value: unknown) => boolean;
  /** The schema a declaration's kind declares, and the named shapes it reaches. */
  schemaOf(declaration: D): { schema: Schema; resolveRef?: NamedShapeResolver } | undefined;
  /** The configuration a declaration's catalogs are read from. */
  configurationOf(declaration: D): unknown;
  /** The reference sites of a declaration. */
  referenceSites(declaration: D): readonly CatalogSetReferenceSite[];
  /** The declaration a reference written in `declaration` names; undefined when
   *  the host cannot tell, which leaves it out of the set. */
  resolve(declaration: D, value: unknown): D | undefined;
  /** What makes two declarations one member. */
  identityOf(declaration: D): unknown;
  /** How a message names a declaration. */
  labelOf(declaration: D): string;
  /** True for a catalog value its fragment's schema accepts; a value it refuses is
   *  reported where it is written and judged no further. */
  accepts?(catalog: unknown): boolean;
}

/** One catalog of a set. */
export interface TextCatalogSetMember<D> {
  readonly catalog: unknown;
  /** The declaration whose configuration holds it — the holder itself for an
   *  inline one. */
  readonly owner: D;
  /** Where in the owner's configuration it is. */
  readonly within: ValuePath;
  /** The holder's reference, or inline catalog, that brings it in. */
  readonly at: ValuePath;
  /** True for a catalog the holder writes itself. */
  readonly inline: boolean;
}

interface SetItem {
  readonly path: ValuePath;
  readonly catalog?: unknown;
  readonly reference?: unknown;
}

/** The catalogs and reference values at the given places of a declaration, in
 *  written order; `everywhere` reads catalogs anywhere in its configuration. */
function itemsOf<D>(declaration: D, host: TextCatalogSetHost<D>, everywhere: boolean): SetItem[] {
  const kind = host.schemaOf(declaration);
  if (!kind) return [];
  const configuration = host.configurationOf(declaration);
  const regions = textCatalogSetRegions(kind.schema, configuration, host.isExpression, kind.resolveRef);
  const inRegion = (path: ValuePath) => regions.some((region) => startsWith(path, region));
  const items: SetItem[] = [];
  if (everywhere || regions.length > 0) {
    const walk = textSites(kind.schema, configuration, { isExpression: host.isExpression, resolveRef: kind.resolveRef });
    for (const site of walk.texts) {
      if (site.fragment !== TEXT_CATALOG_FRAGMENT) continue;
      if (!everywhere && !inRegion(site.path)) continue;
      const catalog = siteValueOf(site);
      if (host.isExpression(catalog) || (host.accepts && !host.accepts(catalog))) continue;
      items.push({ path: site.path, catalog });
    }
  }
  if (regions.length > 0) {
    for (const site of host.referenceSites(declaration)) {
      if (!inRegion(site.keys)) continue;
      if (Array.isArray(site.data)) {
        site.data.forEach((value, index) => items.push({ path: [...site.keys, index], reference: value }));
      } else if (site.data !== undefined) {
        items.push({ path: site.keys, reference: site.data });
      }
    }
  }
  items.sort((a, b) => comparePaths(configuration, a.path, b.path));
  return items;
}

/** Every catalog of the sets a holder's kind marks, in set order, each member once. */
export function textCatalogSetMembers<D>(holder: D, host: TextCatalogSetHost<D>): TextCatalogSetMember<D>[] {
  const members: TextCatalogSetMember<D>[] = [];
  const seen = new Set<unknown>([host.identityOf(holder)]);
  const expand = (declaration: D, at: ValuePath): void => {
    for (const item of itemsOf(declaration, host, true)) {
      if (item.reference === undefined) {
        members.push({ catalog: item.catalog, owner: declaration, within: item.path, at, inline: false });
        continue;
      }
      const referent = host.resolve(declaration, item.reference);
      if (referent === undefined || seen.has(host.identityOf(referent))) continue;
      seen.add(host.identityOf(referent));
      expand(referent, at);
    }
  };
  for (const item of itemsOf(holder, host, false)) {
    if (item.reference === undefined) {
      members.push({ catalog: item.catalog, owner: holder, within: item.path, at: item.path, inline: true });
      continue;
    }
    const referent = host.resolve(holder, item.reference);
    if (referent === undefined || seen.has(host.identityOf(referent))) continue;
    seen.add(host.identityOf(referent));
    expand(referent, item.path);
  }
  return members;
}

/** One text and context a set's catalogs translate twice in one language. */
export interface TextCatalogSetDuplicate<D> {
  /** The occurrence brought in later. */
  readonly member: TextCatalogSetMember<D>;
  /** The occurrence it repeats. */
  readonly first: TextCatalogSetMember<D>;
  /** Where the holder is refused: the reference, or inline catalog, bringing in
   *  the later occurrence. */
  readonly at: ValuePath;
  readonly message: string;
}

const asciiLowercase = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

/**
 * Every repeated (language, text, context) across a set's members — one per
 * occurrence after the first. Each catalog's own entries are read as its
 * judgement reads them, so an entry repeated within one catalog is that
 * catalog's finding and not counted again here.
 */
export function textCatalogSetDuplicates<D>(
  members: readonly TextCatalogSetMember<D>[],
  host: Pick<TextCatalogSetHost<D>, "isExpression" | "labelOf">,
): TextCatalogSetDuplicate<D>[] {
  const first = new Map<string, { member: TextCatalogSetMember<D>; index: number }>();
  const duplicates: TextCatalogSetDuplicate<D>[] = [];
  const name = (member: TextCatalogSetMember<D>): string =>
    member.inline
      ? `the text catalog at '${renderValuePath(member.within)}'`
      : `${host.labelOf(member.owner)}${member.within.length > 0 ? ` at '${renderValuePath(member.within)}'` : ""}`;
  for (const member of members) {
    const lang = (member.catalog as { lang?: unknown } | null)?.lang;
    if (typeof lang !== "string") continue;
    const language = asciiLowercase(lang);
    for (const entry of judgeCatalog(member.catalog, host.isExpression).entries) {
      const key = `${language}\0${entry.key}`;
      const earlier = first.get(key);
      if (!earlier) {
        first.set(key, { member, index: entry.index });
        continue;
      }
      const [source, context] = JSON.parse(entry.key) as [string, string | null];
      const what = `'${source}'${context === null ? "" : ` (context '${context}')`}`;
      const at = renderValuePath(member.at);
      duplicates.push({
        member,
        first: earlier.member,
        at: member.at,
        message:
          `the ${member.inline ? "text catalog" : "reference"} at '${at}' is refused: it brings in ` +
          `${name(member)}, whose texts[${entry.index}] translates ${what} into ${lang}, which ` +
          `${name(earlier.member)} already translates at texts[${earlier.index}] — a catalog set holds one ` +
          `translation of a text per language, so only one of them could ever be used`,
      });
    }
  }
  return duplicates;
}

