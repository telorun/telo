/**
 * What a manifest's CEL READS, as opposed to what its slots reference.
 *
 * A dependency a manifest states without a slot: `!cel "resources.db.dsn"` makes
 * the reader depend on `db` as surely as a `!ref` would, and no reference walk
 * can see it. Two consumers ask for it — the module graph draws it as a `data`
 * edge, and the kernel needs it to know who becomes invalid when a resource is
 * rebuilt — so the extraction is here rather than in either of them.
 *
 * The expensive half is the CEL environment used to parse, which is built once
 * per process and evaluates nothing.
 */
import { ParseError } from "@marcbachmann/cel-js";
import {
  celExpressionsOf,
  extractAccessChains,
  isTaggedSentinel,
  resolveModuleCalls,
  walkCelExpressions,
} from "@telorun/templating";
import type { ResourceManifest } from "@telorun/sdk";
import { buildCelEnvironment } from "./cel-environment.js";

let parseEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/** The parsed tree of `source`, or undefined when it does not parse — a syntax
 *  error is the engine pass's to report, not this one's. Only the parser's own
 *  refusal is read that way; anything else is a defect and propagates. */
function parsedAst(source: string) {
  parseEnv ??= buildCelEnvironment();
  try {
    return parseEnv.parse(source).ast;
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

/** Access chains an expression reads, or none when it does not parse.
 *
 *  `moduleNames` are the declaring module's CEL call names: a call whose
 *  receiver is one of them names a MODULE, so it contributes no chain. A caller
 *  that omits them reads such a receiver as a root, which is the honest answer
 *  when nothing has said which names are modules. */
export function accessChains(source: string, moduleNames?: ReadonlySet<string>): string[][] {
  const ast = parsedAst(source);
  if (!ast) return [];
  resolveModuleCalls(ast, moduleNames);
  return extractAccessChains(ast);
}

/** The qualified module calls an expression makes, or none when it does not
 *  parse. A source that spells none of the names makes none of the calls, so it
 *  is not parsed. */
export function moduleCallsInSource(source: string, moduleNames: ReadonlySet<string>): string[] {
  let spellsOne = false;
  for (const name of moduleNames) {
    if (source.includes(name)) {
      spellsOne = true;
      break;
    }
  }
  if (!spellsOne) return [];
  const ast = parsedAst(source);
  return ast ? resolveModuleCalls(ast, moduleNames) : [];
}

/** One qualified module call and the path of the value that makes it. */
export interface ModuleCallSite {
  /** `walkCelExpressions` spelling: `routes[0].handler`. */
  readonly path: string;
  readonly call: string;
}

/**
 * Every module call a manifest's values make, once per value and qualified name.
 *
 * A compiled value already carries its calls (`CompiledValue.calls`), resolved
 * against the names of the module that compiled it — the list the kernel binds
 * at `create()` — and is read as is. A `!cel` sentinel no loader compiled is
 * parsed against `moduleNames`, the declaring module's. A plain string is never
 * an expression. Plain containers
 * only: a live instance written into a slot after injection is not the
 * manifest's.
 */
export function moduleCallSites(
  manifest: ResourceManifest,
  moduleNames: ReadonlySet<string>,
): ModuleCallSite[] {
  const out: ModuleCallSite[] = [];
  const seen = new WeakSet<object>();
  const record = (path: string, calls: Iterable<string>) => {
    for (const call of new Set(calls)) out.push({ path, call });
  };
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const compiled = value as { __compiled?: unknown; calls?: unknown };
    if (compiled.__compiled === true) {
      if (Array.isArray(compiled.calls)) {
        record(
          path,
          compiled.calls.filter((call): call is string => typeof call === "string"),
        );
      }
      return;
    }
    if (isTaggedSentinel(value)) {
      record(
        path,
        celExpressionsOf(value.engine, value.source).flatMap((x) => moduleCallsInSource(x, moduleNames)),
      );
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
  };
  visit(manifest, "");
  return out;
}

/**
 * The bare resource names a manifest's expressions read through
 * `resources.<name>`, deduplicated.
 *
 * Read from the DECLARATION: a compile-eval field is expanded before a
 * controller sees it, so by then `resources.db.dsn` is a literal with nothing
 * left to say where it came from.
 *
 * No module-name set, and it cannot change the answer: what this collects is
 * rooted at the kernel global `resources`, while a module call's receiver is a
 * TYPE-level name — PascalCase, enforced as an error by `INVALID_TYPE_NAME` on
 * every module name and import alias — so no receiver can ever be read as one.
 * Its caller is the kernel's create sub-phase, where the alias table is still
 * filling as imports are created, so a set taken from there would be a claim
 * about the module that happens to be true only late in the loop.
 */
export function celResourceReads(manifest: ResourceManifest): string[] {
  const names = new Set<string>();
  walkCelExpressions(manifest as Record<string, unknown>, "", (source, _path, engine) => {
    for (const expression of celExpressionsOf(engine, source)) {
      for (const name of resourceReadsOf(expression)) names.add(name);
    }
  });
  return [...names];
}

/** Keyed on the text alone, which is all the answer depends on: a library's
 *  expressions are read once per import site, and parsing is the whole cost.
 *  Least-recently-used and bounded, because a long-lived host (an editor, a
 *  watch session) sees new expression text on every edit. */
const RESOURCE_READS_CAPACITY = 4096;
const resourceReadsBySource = new Map<string, readonly string[]>();

function resourceReadsOf(source: string): readonly string[] {
  let reads = resourceReadsBySource.get(source);
  if (reads) {
    resourceReadsBySource.delete(source);
  } else {
    reads = accessChains(source)
      .filter((chain) => chain[0] === "resources" && chain.length >= 2 && chain[1])
      .map((chain) => chain[1]);
    if (resourceReadsBySource.size >= RESOURCE_READS_CAPACITY) {
      resourceReadsBySource.delete(resourceReadsBySource.keys().next().value!);
    }
  }
  resourceReadsBySource.set(source, reads);
  return reads;
}
