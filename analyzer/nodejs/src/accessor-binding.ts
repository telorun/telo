/**
 * WHAT AN ACCESSOR FIELD HOLDS — the one reader of `x-telo-eval: accessor`
 * values.
 *
 * An accessor field NAMES a value for the resource's consumer to resolve: a
 * `!cel` plain chain rooted at one of the field's context bindings
 * (`row.isDone`), or a literal. It is typed like any CEL leaf and never
 * evaluated, so nothing but a chain can be written as an expression there — a
 * call, an operator, an index, `!interpolate` or a tag anywhere beneath the
 * field has nothing to run it.
 *
 * The static verdict (`ACCESSOR_NOT_PLAIN_CHAIN`) and the kernel's refusal at
 * creation (`ERR_ACCESSOR_NOT_PLAIN_CHAIN`) both read this file, and the kernel
 * delivers what {@link accessorBindingOf} returns — so the positions refused
 * and the value handed to a controller are decided once.
 *
 * Browser-safe; re-imported by the kernel.
 */
import type { CelEnvironment } from "@telorun/cel";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  defaultRegistry,
  isRefSentinel,
  isTaggedSentinel,
  plainChainOf,
} from "@telorun/templating";
import { buildCelEnvironment } from "./cel-environment.js";
import { accessorFieldAt, type AccessorSite, type CelEvalSites } from "./eval-paths.js";

/**
 * What a controller receives at an accessor field: a chain as its root binding
 * and the member names below it, or a literal wrapped so that a literal shaped
 * like a chain is never mistaken for one.
 */
export type AccessorBinding = { root: string; path: string[] } | { value: unknown };

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

function describeBindings(site: AccessorSite): string {
  return site.bindings.length > 0
    ? site.bindings.map((name) => `'${name}'`).join(", ")
    : "none — the field has no x-telo-context";
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
        if (node !== undefined) out.push({ site, path, keys, value: node });
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
 * name: `!cel` — one plain chain — as the field's whole value, and none
 * anywhere beneath it. What an editor offers there, so it offers nothing
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
  const { site, path, value } = field;
  const isLiteral = (node: unknown, tag: AccessorTag) =>
    isLiteralTag(node, tag) || resolvedEarlier(tag);
  const tag = tagOf(value);
  if (tag && !isLiteral(value, tag)) {
    const chain = plainChainOf(value);
    if (chain === undefined) {
      return [
        {
          path,
          message:
            `'${path}: !${tag.engine} "${tag.source}"' is not a plain chain. An accessor field ` +
            `names a value for its consumer to resolve and is never evaluated, so only ` +
            `identifiers joined by dots can be written there as an expression — rooted at one of ` +
            `the field's bindings (${describeBindings(site)}). A call, an operator, an index or ` +
            `interpolation has nothing to run it. Write a plain chain, or a literal value.`,
        },
      ];
    }
    const root = chain.split(".")[0]!;
    if (!site.bindings.includes(root)) {
      return [
        {
          path,
          unboundRoot: root,
          message:
            `'${path}: !cel "${tag.source}"' is not a plain chain the field can name: it starts ` +
            `at '${root}', which the field's context does not declare (${describeBindings(site)}). ` +
            `An accessor field is never evaluated, so a chain there starts at one of its own bindings.`,
        },
      ];
    }
    return [];
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

/** What a controller receives for a value {@link accessorProblems} accepts. */
export function accessorBindingOf(value: unknown): AccessorBinding {
  const chain = plainChainOf(value);
  if (chain === undefined) return { value };
  const [root, ...path] = chain.split(".");
  return { root: root!, path };
}
