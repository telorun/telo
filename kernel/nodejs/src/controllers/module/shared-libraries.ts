import type { EvaluationContext as IEvaluationContext, ResourceInstance } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import type { ModuleContext } from "../../module-context.js";
import type { ParsedExportEntry } from "@telorun/analyzer";

/**
 * LIBRARY SINGLETONS — one instantiation of a `lifecycle: shared` library per
 * application, borrowed by every import that names it.
 *
 * An import declaration otherwise builds its own child scope with its own
 * instances, so two libraries importing a third get two of everything in it.
 * That is right for a library whose instances are the importer's — a client
 * configured per consumer — and wrong for one that owns a resource the
 * application has exactly one of. `lifecycle: shared` names the second case, and
 * it is what lets a set of libraries share a dependency without linearizing them
 * into a chain that re-exports the union of everything beneath it.
 *
 * **The root owns it; every import borrows it** — the same rule an injected
 * resource follows. The child context is spawned under the ROOT rather than
 * under whichever import happened to reach it first, because otherwise tearing
 * that importer down would close a library two others still hold, and which
 * importer that is depends on init order. It is torn down after every other root
 * child (`TEARDOWN_LAST` on the context), so a borrower's own inverses still
 * find it alive.
 *
 * **Registered only when shared**, which is what makes a registry HIT the answer
 * to "is this library shared" — a second import of one costs no fetch, no parse
 * and no analysis pass at all.
 */
export interface SharedLibrary {
  /** The resolved module URL — the identity two imports must agree on. Carries
   *  any `#sha256-` pin, so two imports of the same source at different
   *  integrity are different libraries, which is the truth. */
  readonly url: string;
  readonly module: string;
  /** The alias of the import that instantiated it, named in a conflict. */
  readonly owner: string;
  readonly context: ModuleContext;
  readonly child: IEvaluationContext;
  readonly variables: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
  /** The instances supplied for the library's declared `resources:` inputs,
   *  compared by IDENTITY: two imports handing down different instances of the
   *  same kind is exactly the split a singleton exists to prevent. */
  readonly resources: ReadonlyMap<string, ResourceInstance>;
  readonly declaredVariables: Record<string, any>;
  readonly declaredSecrets: Record<string, any>;
  readonly exportEntries: readonly ParsedExportEntry[];
  readonly kindEntries: readonly ParsedExportEntry[];
  readonly exportedResourceNames: readonly string[];
  readonly exportedKindSuffixes: readonly string[] | undefined;
  /** Build the library's resources and export tables. Carried on the ENTRY
   *  rather than in one import's closure because the import that REGISTERS a
   *  singleton is not necessarily the one whose `init()` runs first. */
  readonly build: () => Promise<void>;
  /** Memoized initialization. Whichever import's `init()` runs first starts it
   *  and every other awaits the same promise, so a borrower can never proceed
   *  against a library whose resources have not been built — an ordering the
   *  multi-pass loop does not otherwise guarantee. */
  initialized?: Promise<void>;
}

/** Per-kernel, hung off the ROOT context rather than held in module scope, so
 *  two in-process kernels never share a library instance. */
const registries = new WeakMap<object, Map<string, SharedLibrary>>();

/** The root of a context's lifecycle tree — the kernel's own root context. */
export function rootContextOf(ctx: IEvaluationContext): IEvaluationContext {
  let node: IEvaluationContext = ctx;
  while (node.parent) node = node.parent;
  return node;
}

/** The shared-library registry for the kernel `ctx` belongs to. */
export function sharedLibraries(ctx: IEvaluationContext): Map<string, SharedLibrary> {
  const root = rootContextOf(ctx) as unknown as object;
  let registry = registries.get(root);
  if (!registry) registries.set(root, (registry = new Map()));
  return registry;
}

/**
 * Refuse a second import that would instantiate the library differently.
 *
 * A singleton has one configuration, so the only sound reading of two imports
 * supplying different values is that one of them is wrong — and which one cannot
 * be decided here. Resolved by init order it would be whichever import was
 * created first, silently, which is the failure mode `lifecycle: shared` is
 * supposed to remove rather than relocate.
 *
 * A secret's VALUE is never printed: the key is what the author has to look at.
 */
export function assertSharedInputsAgree(
  entry: SharedLibrary,
  alias: string,
  variables: Record<string, unknown>,
  secrets: Record<string, unknown>,
  resources: ReadonlyMap<string, { instance: ResourceInstance }>,
): void {
  const conflict = (block: string, key: string, detail?: string): never => {
    throw new RuntimeError(
      "ERR_SHARED_LIBRARY_CONFLICT",
      `Import '${alias}' and import '${entry.owner}' both reach module '${entry.module}', which ` +
        `declares 'lifecycle: shared' — one instantiation for the whole application — but they ` +
        `supply different values for ${block}.${key}${detail ? ` (${detail})` : ""}. Make the two ` +
        `imports agree, or make the library 'lifecycle: isolated'.`,
    );
  };

  for (const key of union(Object.keys(entry.variables), Object.keys(variables))) {
    if (!sameValue(entry.variables[key], variables[key])) {
      conflict("variables", key, `'${render(entry.variables[key])}' vs '${render(variables[key])}'`);
    }
  }
  // Values withheld deliberately — a diagnostic must not become a way to read a
  // secret out of a running process.
  for (const key of union(Object.keys(entry.secrets), Object.keys(secrets))) {
    if (!sameValue(entry.secrets[key], secrets[key])) conflict("secrets", key);
  }
  for (const key of union([...entry.resources.keys()], [...resources.keys()])) {
    if (entry.resources.get(key) !== resources.get(key)?.instance) {
      conflict("resources", key, "different instances");
    }
  }
}

/** Reject a per-import override a singleton has no room for. The analyzer
 *  reports the same thing as `SHARED_LIBRARY_OVERRIDE`; this is the runtime
 *  half, for a library reached through a programmatic load that never passed
 *  `telo check`. */
export function assertNoSharedOverride(resource: any, alias: string, module: string): void {
  for (const field of ["logging", "runtime"] as const) {
    if (resource[field] === undefined) continue;
    throw new RuntimeError(
      "ERR_SHARED_LIBRARY_OVERRIDE",
      `Import '${alias}' declares '${field}:', but module '${module}' is 'lifecycle: shared' — ` +
        `one instantiation for the whole application, so a per-import override cannot apply to ` +
        `it. Remove it, or make the library 'lifecycle: isolated'.`,
    );
  }
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Structural equality over the JSON-shaped values a config input carries.
 * `undefined` and an absent key are the same absence.
 *
 * Key ORDER is not part of a value: two imports writing the same object variable
 * with its keys in a different YAML order are supplying the same thing, and a
 * conflict here is a hard boot failure telling the author the two imports
 * disagree — a false positive is both expensive and unexplainable.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = union(Object.keys(left), Object.keys(right));
    return keys.every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
