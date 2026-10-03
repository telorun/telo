/**
 * Loading the function catalog into an environment.
 *
 * The catalog is the **dialect**: the functions a manifest may call beside CEL's own
 * library. Like the standard library it is **data** (`signatures/function-catalog.json`)
 * read through the same registration surface a host uses — here literally the public one,
 * `CelEnvironment.registerFunction`, with no privileged door of any kind. A host may
 * register the catalog, leave it out, replace one of its signatures or remove a name, and
 * nothing in the engine behaves differently for it.
 *
 * **One surface, read by everything that lists the catalog.** `functionCatalog()` answers
 * each function with its display signature, its category, its summary and its two flags,
 * which is exactly what a `functions` listing prints; a consumer never reconstructs that
 * from registrations.
 *
 * What a function DOES is beside it, per runtime — `catalog-runtime.ts`, keyed by the same
 * dispatch key the registry resolves on. A declared signature with no behaviour there is
 * refused at registration rather than at evaluation, which is the failure class the two
 * artifacts exist to remove.
 */

import data from "./signatures/function-catalog.json" with { type: "json" };
import type { CelCatalogHandlers } from "./catalog-runtime.js";
import { catalogImplementation, catalogLiteralCheck } from "./catalog-runtime.js";
import type { CelEnvironment } from "./environment.js";
import { parseSignature, signatureKey } from "./signature.js";

interface CatalogEntryData {
  readonly name: string;
  readonly signature: string;
  readonly signatures: readonly string[];
  readonly category: string;
  readonly summary: string;
  readonly deterministic: boolean;
  readonly hostBacked: boolean;
  readonly checksLiteralArguments?: boolean;
}

interface CatalogData {
  readonly generation: number;
  readonly spec: boolean;
  readonly reason: string;
  readonly categories: readonly string[];
  readonly functions: readonly CatalogEntryData[];
}

const DATA = data as unknown as CatalogData;

export const FUNCTION_CATALOG_GENERATION = DATA.generation;

/** The categories the catalog groups its functions under, for a grouped listing. */
export function catalogCategories(): readonly string[] {
  return DATA.categories;
}

/** One function of the catalog, as a listing prints it. */
export interface CatalogFunction {
  readonly name: string;
  /**
   * The signature a human reads, which is not always one registration: an optional
   * parameter is written `fn(string?): string` and registers one signature per arity.
   */
  readonly signature: string;
  /** Every signature the function registers, in registration order. */
  readonly signatures: readonly string[];
  readonly category: string;
  readonly summary: string;
  /** False where two calls with the same arguments may answer differently. */
  readonly deterministic: boolean;
  /** Whether the implementation is the host's rather than the engine's. */
  readonly hostBacked: boolean;
  /** Whether the function refuses an argument written as a literal, at check. */
  readonly checksLiteralArguments: boolean;
}

/** The catalog, as the one surface a listing reads. */
export function functionCatalog(): readonly CatalogFunction[] {
  return DATA.functions.map((entry) => ({
    name: entry.name,
    signature: entry.signature,
    signatures: entry.signatures,
    category: entry.category,
    summary: entry.summary,
    deterministic: entry.deterministic,
    hostBacked: entry.hostBacked,
    checksLiteralArguments: entry.checksLiteralArguments ?? false,
  }));
}

/** Every signature the catalog registers, for a validator and for a docs listing. */
export function catalogSignatures(): readonly string[] {
  return DATA.functions.flatMap((entry) => entry.signatures);
}

export interface RegisterCatalogOptions {
  /**
   * The implementations of the nine host-backed functions. Each may be left out — the
   * registration is still made, so an expression calling it still type-checks, and
   * evaluating one answers an `unbound_function` error naming the function. That is what
   * a consumer which only ever CHECKS (an analyzer, an editor) needs.
   */
  readonly handlers?: Partial<CelCatalogHandlers>;
}

/**
 * Registers the catalog onto an environment, through the public registration surface.
 *
 * A signature the runtime table does not answer for is refused here: a declaration with
 * no behaviour type-checks and then fails at evaluation, which is precisely the failure
 * the declaration/behaviour split exists to catch at registration instead.
 */
export function registerFunctionCatalog(
  environment: CelEnvironment,
  options: RegisterCatalogOptions = {},
): void {
  const handlers = options.handlers ?? {};
  for (const entry of DATA.functions) {
    const check = entry.checksLiteralArguments ? catalogLiteralCheck(entry.name) : undefined;
    if (entry.checksLiteralArguments && check === undefined) {
      throw new Error(
        `the catalog declares that ${entry.name} checks its literal arguments, and no guard answers for it`,
      );
    }
    for (const signature of entry.signatures) {
      const key = signatureKey(parseSignature(signature));
      const implementation = catalogImplementation(key, handlers);
      if (implementation === undefined) {
        throw new Error(`the catalog declares ${signature} and nothing implements ${key}`);
      }
      environment.registerFunction(signature, {
        implementation,
        deterministic: entry.deterministic,
        hostBacked: entry.hostBacked,
        description: entry.summary,
        origin: "function-catalog",
        ...(check === undefined ? {} : { checkArguments: check }),
      });
    }
  }
}
