/**
 * WHAT AN ACCESSOR FIELD HOLDS — the one reader of `x-telo-eval: accessor` and
 * `x-telo-eval: accessor-template` values.
 *
 * An accessor field NAMES a value for the resource's consumer to resolve: a
 * `!cel` plain chain rooted at one of the field's context bindings
 * (`row.isDone`), or a literal. It is typed like any CEL leaf and never
 * evaluated, so nothing but a chain can be written as an expression there — a
 * call, an operator, an index, `!interpolate` or a tag anywhere beneath the
 * field has nothing to run it. An accessor TEMPLATE field may also hold a map
 * or a list of such values, at any depth: each leaf is a chain or a literal.
 *
 * The static verdict (`ACCESSOR_NOT_PLAIN_CHAIN`) and the kernel's refusal at
 * creation (`ERR_ACCESSOR_NOT_PLAIN_CHAIN`) both read this file, and
 * {@link withAccessorBindings} is the one writer — what the kernel delivers and
 * what a rule reads — so the positions refused and the value handed over are
 * decided once.
 *
 * Browser-safe; re-imported by the kernel.
 */
import type { CelEnvironment } from "@telorun/cel";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  celExpressionsOf,
  defaultRegistry,
  isRefSentinel,
  isTaggedSentinel,
  plainChainOf,
} from "@telorun/templating";
import { accessChains } from "./cel-access-chains.js";
import { buildCelEnvironment } from "./cel-environment.js";
import { setOwnProperty } from "./own-property.js";
import {
  accessorBindingNamesAt,
  accessorFieldAt,
  type AccessorSite,
  type CelEvalSites,
} from "./eval-paths.js";

/**
 * What a controller receives at an accessor field: a chain as its root binding
 * and the member names below it, or a literal wrapped so that a literal shaped
 * like a chain is never mistaken for one. At an `accessor-template` field a
 * structure holding a chain is `{ map }` / `{ list }` of the bindings of its
 * entries; one holding none is `{ value }`.
 */
export type AccessorBinding =
  | { root: string; path: string[] }
  | { value: unknown }
  | { map: Record<string, AccessorBinding> }
  | { list: AccessorBinding[] };

/** A value an accessor field cannot hold, at its concrete path. */
export interface AccessorProblem {
  path: string;
  message: string;
  /** Set when the only fault is a chain rooted at a name the field's context
   *  does not declare. */
  unboundRoot?: string;
}

/** One accessor field of a resource: where it is, and what was written there. */
export interface AccessorField {
  site: AccessorSite;
  path: string;
  /** The segments reaching `path` from the resource root. */
  keys: (string | number)[];
  value: unknown;
  /** The names a chain written here may start at, read at `path`. */
  bindings: readonly string[];
}

/** A tag as either half holds one: the analyzer's sentinel, or the compiled
 *  value the loader put in its place. */
function tagOf(value: unknown): { engine: string; source: string } | undefined {
  if (!isTaggedSentinel(value) && !isCompiledValue(value)) return undefined;
  const { engine, source } = value as { engine?: unknown; source?: unknown };
  return typeof engine === "string" && typeof source === "string" ? { engine, source } : undefined;
}

let compileEnv: CelEnvironment | undefined;

/** True for a tag the loader replaces with a plain value (`!literal`): written
 *  as a tag, held as the literal it stands for. Asked of the engine by compiling
 *  the text, as the loader does, never of the tag's name. */
function isLiteralTag(value: unknown, tag: { engine: string; source: string }): boolean {
  if (isCompiledValue(value) || isRefSentinel(value)) return false;
  const engine = defaultRegistry().get(tag.engine);
  if (!engine || engine.expressionRegions) return false;
  compileEnv ??= buildCelEnvironment();
  const compiled = engine.compile(tag.source, { celEnv: compileEnv });
  return !isCompiledValue(compiled) && !isTaggedSentinel(compiled);
}

function describeBindings(bindings: readonly string[]): string {
  return bindings.length > 0
    ? bindings.map((name) => `'${name}'`).join(", ")
    : "none — no x-telo-context binding here exists at an accessor";
}

function isPlainObject(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const prototype = Object.getPrototypeOf(node);
  return prototype === Object.prototype || prototype === null;
}

/** Every accessor field `resource` fills, at its concrete path. */
export function accessorFields(
  resource: Record<string, unknown>,
  sites: CelEvalSites,
): AccessorField[] {
  if (!sites.accessor?.length) return [];
  const out: AccessorField[] = [];
  const walk = (node: unknown, path: string, keys: (string | number)[]): void => {
    if (path !== "") {
      const site = accessorFieldAt(sites, path);
      if (site) {
        if (node !== undefined) out.push({ site, path, keys, value: node, bindings: accessorBindingNamesAt(sites, path) });
        return;
      }
    }
    if (!node || typeof node !== "object" || tagOf(node)) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, [...keys, index]));
      return;
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path === "" ? key : `${path}.${key}`, [...keys, key]);
    }
  };
  walk(resource, "", []);
  return out;
}

/**
 * The tags an author may write where an accessor field's value goes, by engine
 * name: `!cel` — one plain chain — as the field's whole value (or, in an
 * `accessor-template` field, as any value within it), and none anywhere beneath
 * that. What an editor offers there, so it offers nothing
 * {@link accessorProblems} then refuses.
 */
export function accessorTagEngines(atField: boolean): readonly string[] {
  return atField ? [CEL_ENGINE] : [];
}

/** A tag as an accessor field's reader sees one. */
export interface AccessorTag {
  engine: string;
  source: string;
}

/**
 * Why the value written at an accessor field cannot stay — empty when it is a
 * plain chain rooted at one of the field's bindings, or a literal holding no
 * tag.
 *
 * `resolvedEarlier` names the tags the host has already replaced with a value
 * by the time the resource is created, which are literals to this rule: a
 * template body's entry is expanded against `self` before its own creation.
 */
export function accessorProblems(
  field: AccessorField,
  resolvedEarlier: (tag: AccessorTag) => boolean = () => false,
): AccessorProblem[] {
  const { site, path, value, bindings } = field;
  const isLiteral = (node: unknown, tag: AccessorTag) =>
    isLiteralTag(node, tag) || resolvedEarlier(tag);
  const chainProblem = (node: unknown, at: string, tag: AccessorTag): AccessorProblem | undefined => {
    const chain = plainChainOf(node);
    if (chain === undefined) {
      return {
        path: at,
        message: site.template
          ? `'${at}: !${tag.engine} "${tag.source}"' is not a plain chain. An accessor template ` +
            `names values for its consumer to resolve and is never evaluated, so each value in ` +
            `it is a literal or a plain chain — identifiers joined by dots, rooted at one of ` +
            `the field's bindings (${describeBindings(bindings)}). A call, an operator, an index or ` +
            `interpolation has nothing to run it. Write a plain chain, or a literal value.`
          : `'${at}: !${tag.engine} "${tag.source}"' is not a plain chain. An accessor field ` +
            `names a value for its consumer to resolve and is never evaluated, so only ` +
            `identifiers joined by dots can be written there as an expression — rooted at one of ` +
            `the field's bindings (${describeBindings(bindings)}). A call, an operator, an index or ` +
            `interpolation has nothing to run it. Write a plain chain, or a literal value.`,
      };
    }
    const root = chain.split(".")[0]!;
    if (bindings.includes(root)) return undefined;
    return {
      path: at,
      unboundRoot: root,
      message:
        `'${at}: !cel "${tag.source}"' is not a plain chain the field can name: it starts ` +
        `at '${root}', which the field's context does not declare at an accessor (${describeBindings(bindings)}). ` +
        `An accessor field is never evaluated, so a chain there starts at one of its own bindings.`,
    };
  };
  if (site.template) {
    const problems: AccessorProblem[] = [];
    const walk = (node: unknown, at: string): void => {
      const tag = tagOf(node);
      if (tag) {
        const problem = isLiteral(node, tag) ? undefined : chainProblem(node, at, tag);
        if (problem) problems.push(problem);
        return;
      }
      if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${at}[${index}]`));
      else if (isPlainObject(node)) for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`);
    };
    walk(value, path);
    return problems;
  }
  const tag = tagOf(value);
  if (tag && !isLiteral(value, tag)) {
    const problem = chainProblem(value, path, tag);
    return problem ? [problem] : [];
  }
  const problems: AccessorProblem[] = [];
  const walk = (node: unknown, at: string): void => {
    const nested = tagOf(node);
    if (nested) {
      if (isLiteral(node, nested)) return;
      problems.push({
        path: at,
        message:
          `'${at}: !${nested.engine} "${nested.source}"' is written beneath the accessor field ` +
          `'${path}', so it is not a plain chain the field names. An accessor field is never ` +
          `evaluated: it holds one plain chain as its whole value, or a literal with no tag ` +
          `inside it.`,
      });
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return problems;
}

/** True when every value a tag's expressions read is rooted at `self` — a tag
 *  a template body has resolved by the time its entry is created. */
export function readsOnlySelf(tag: AccessorTag): boolean {
  const expressions = celExpressionsOf(tag.engine, tag.source);
  return (
    expressions.length > 0 &&
    expressions.every((expression) => {
      const chains = accessChains(expression);
      return chains.length > 0 && chains.every((chain) => chain[0] === "self");
    })
  );
}

/** What a controller receives for a value {@link accessorProblems} accepts. A
 *  tag `resolvedEarlier` names is a literal of a value not yet known, so it is
 *  wrapped as written and never read as a chain. With `template`, a map or a
 *  list holding a chain is the `{ map }` / `{ list }` of its entries' bindings. */
export function accessorBindingOf(
  value: unknown,
  resolvedEarlier: (tag: AccessorTag) => boolean = () => false,
  template = false,
): AccessorBinding {
  const chainOf = (node: unknown): string | undefined => {
    const tag = tagOf(node);
    return tag && resolvedEarlier(tag) ? undefined : plainChainOf(node);
  };
  const holdsChain = (node: unknown): boolean => {
    if (tagOf(node)) return chainOf(node) !== undefined;
    if (Array.isArray(node)) return node.some(holdsChain);
    return isPlainObject(node) && Object.values(node).some(holdsChain);
  };
  const bind = (node: unknown): AccessorBinding => {
    const chain = chainOf(node);
    if (chain !== undefined) {
      const [root, ...path] = chain.split(".");
      return { root: root!, path };
    }
    if (!template || !holdsChain(node)) return { value: node };
    if (Array.isArray(node)) return { list: node.map(bind) };
    return {
      map: Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, bind(child)])),
    };
  };
  return bind(value);
}

/** Every place within an accessor field where a chain is written, each with
 *  the segments reaching it from the resource root: the field itself, or —
 *  in an `accessor-template` field — any value within it. */
export function accessorChainPlaces(field: AccessorField): { path: string; keys: (string | number)[]; value: unknown }[] {
  const out: { path: string; keys: (string | number)[]; value: unknown }[] = [];
  const walk = (node: unknown, path: string, keys: (string | number)[]): void => {
    const tag = tagOf(node);
    if (tag) {
      if (plainChainOf(node) !== undefined) out.push({ path, keys, value: node });
      return;
    }
    if (!field.site.template) return;
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}[${index}]`, [...keys, index]));
    else if (isPlainObject(node)) for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`, [...keys, key]);
  };
  walk(field.value, field.path, field.keys);
  return out;
}

/**
 * `resource` with each accessor field replaced by its binding — the one writer.
 * Every container on the way to a field is copied, so the resource handed in
 * keeps what its author wrote; with no field it is returned by identity.
 */
export function withAccessorBindings<T extends Record<string, unknown>>(
  resource: T,
  fields: readonly AccessorField[],
  resolvedEarlier?: (tag: AccessorTag) => boolean,
): T {
  if (fields.length === 0) return resource;
  const copied = new Set<object>();
  const copy = (holder: Record<string | number, unknown>, key: string | number) => {
    const child = holder[key] as object;
    if (copied.has(child)) return child as Record<string | number, unknown>;
    const fresh = (Array.isArray(child) ? [...child] : { ...child }) as Record<
      string | number,
      unknown
    >;
    copied.add(fresh);
    setOwnProperty(holder, key, fresh);
    return fresh;
  };
  const root = { ...resource } as Record<string | number, unknown>;
  for (const { keys, value, site } of fields) {
    let holder = root;
    for (const key of keys.slice(0, -1)) holder = copy(holder, key);
    setOwnProperty(holder, keys[keys.length - 1]!, accessorBindingOf(value, resolvedEarlier, site.template === true));
  }
  return root as T;
}
