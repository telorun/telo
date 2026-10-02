/**
 * Loading CEL's standard library into an environment.
 *
 * The library is **data** (`signatures/standard-library.json`) read through the same
 * registration surface a host uses, with no privileged path of any kind. That is what
 * makes a standard signature replaceable and removable, which is the capability the
 * package exists for: an engine whose library registers itself through a private door
 * cannot have one of its signatures overridden, and an override is how a host gives
 * `duration(string)` a type of its own.
 *
 * Nothing here is an implementation — the library's declarations and its behaviour are
 * separate concerns, and a checker needs only the first.
 */

import library from "./signatures/standard-library.json" with { type: "json" };
import type { CelType } from "./cel-type.js";
import { TYPE } from "./cel-type.js";
import type { FunctionRegistry } from "./function-registry.js";
import type { FunctionMetadata } from "./signature.js";
import { parseSignature } from "./signature.js";
import type { NominalResolver } from "./type-expression.js";
import { parseTypeExpression } from "./type-expression.js";

interface FunctionEntryData {
  readonly signature: string;
  /**
   * `false` where CEL itself does not define the member. It is a **declaration**, not a
   * note: the validator requires a `reason` beside it, so the library cannot grow a
   * member that nobody said was outside the language.
   */
  readonly spec?: boolean;
  readonly reason?: string;
  readonly deterministic?: boolean;
  readonly description?: string;
}

interface OperatorEntryData {
  readonly operator: string;
  readonly parameters: readonly string[];
  readonly returns: string;
}

interface LibraryData {
  readonly generation: number;
  readonly typeConstants: readonly string[];
  readonly constants: readonly { name: string; type: string; description?: string }[];
  readonly functions: readonly FunctionEntryData[];
  readonly optionalTypeConstants: readonly string[];
  readonly optionalTypeOperators: readonly OperatorEntryData[];
  readonly optionalTypeFunctions: readonly FunctionEntryData[];
  readonly operators: readonly OperatorEntryData[];
  readonly symmetricOperators: readonly {
    readonly operators: readonly string[];
    readonly types: readonly string[];
    readonly returns: string;
  }[];
  readonly crossNumericOperators: {
    readonly operators: readonly string[];
    readonly pairs: readonly (readonly string[])[];
    readonly returns: string;
  };
}

const DATA = library as unknown as LibraryData;

export const STANDARD_LIBRARY_GENERATION = DATA.generation;

/** A constant the standard library declares: its name and the type it reads as. */
export interface StandardConstant {
  readonly name: string;
  readonly type: CelType;
  readonly description?: string;
}

/**
 * Every name the library declares as a constant: the type names (`int`, `list`, …),
 * each of type `type`, and `google`, through which the well-known type names are read.
 */
export function standardConstants(optionalTypes: boolean): readonly StandardConstant[] {
  const names = [...DATA.typeConstants, ...(optionalTypes ? DATA.optionalTypeConstants : [])];
  const types = names.map((name) => ({ name, type: TYPE }));
  const named = DATA.constants.map((entry) => ({
    name: entry.name,
    type: parseTypeExpression(entry.type),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  }));
  return [...types, ...named];
}

/** The value `google` reads as: the two well-known type names, as type values. */
export function googleTypeNames(): ReadonlyMap<string, readonly string[]> {
  return new Map([["protobuf", ["Duration", "Timestamp"]]]);
}

const metadataOf = (entry: FunctionEntryData): FunctionMetadata => ({
  deterministic: entry.deterministic ?? true,
  origin: "standard-library",
  ...(entry.description === undefined ? {} : { description: entry.description }),
});

/**
 * Registers the library onto a registry. `optionalTypes` adds the optional-type
 * members, which exist only where the option enables them.
 */
export function registerStandardLibrary(
  registry: FunctionRegistry,
  options: { optionalTypes: boolean; resolveNominal?: NominalResolver },
): void {
  for (const entry of DATA.functions) {
    registry.register(parseSignature(entry.signature, options.resolveNominal), metadataOf(entry));
  }
  if (options.optionalTypes) {
    for (const entry of DATA.optionalTypeFunctions) {
      registry.register(parseSignature(entry.signature, options.resolveNominal), metadataOf(entry));
    }
    for (const entry of DATA.optionalTypeOperators) registerOperatorData(registry, entry);
  }
  for (const entry of DATA.operators) registerOperatorData(registry, entry);
  for (const group of DATA.symmetricOperators) {
    for (const operator of group.operators) {
      for (const type of group.types) {
        registerOperatorData(registry, { operator, parameters: [type, type], returns: group.returns });
      }
    }
  }
  const cross = DATA.crossNumericOperators;
  for (const operator of cross.operators) {
    for (const [left, right] of cross.pairs) {
      registerOperatorData(registry, { operator, parameters: [left!, right!], returns: cross.returns });
    }
  }
}

function registerOperatorData(registry: FunctionRegistry, entry: OperatorEntryData): void {
  registry.register(
    {
      name: entry.operator,
      form: "global",
      parameters: entry.parameters.map((text) => parseTypeExpression(text)),
      returns: parseTypeExpression(entry.returns),
    },
    { deterministic: true, origin: "standard-library" },
  );
}

/** Every signature of the library as text, for a validator and for a docs listing. */
export function standardLibrarySignatures(): readonly string[] {
  return [...DATA.functions, ...DATA.optionalTypeFunctions].map((entry) => entry.signature);
}
