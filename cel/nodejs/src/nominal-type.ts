/**
 * Named types a host registers — the one mechanism, with none of the vocabulary.
 *
 * A nominal type is a name over a base type, with its own operators, comparisons,
 * conversions and member functions, and with named **invariant** type parameters. It
 * is not its base: a value of the base does not stand where the named type is wanted,
 * and only what the definition declares applies to it. That is what makes a named type
 * worth having — a slot that wants one refuses a plain value of the base, which is
 * exactly what an engine typing by wrapper class cannot express.
 *
 * Invariance is deliberate: `Holder<string>` and `Holder<int>` are unrelated, so a
 * type argument that differs is a mistake with its own diagnostic rather than a silent
 * widening to the base.
 *
 * `Self` inside a definition names the type being defined, with its own parameters
 * applied, so a member can answer its own type without repeating it.
 */

import type { CelType, NominalType } from "./cel-type.js";
import { parameterOf } from "./cel-type.js";
import type { NominalResolver } from "./type-expression.js";
import { parseTypeExpression } from "./type-expression.js";

export interface NominalOperatorDeclaration {
  readonly operator: string;
  /** Type expressions; `Self` names the type being defined. */
  readonly parameters: readonly string[];
  readonly returns: string;
}

export interface NominalTypeDefinition {
  readonly name: string;
  /** The type expression a value of this type is, underneath. */
  readonly base: string;
  /** Invariant type parameter names, each a single capital letter. */
  readonly parameters?: readonly string[];
  /** Operators over the type, written with `Self`. */
  readonly operators?: readonly NominalOperatorDeclaration[];
  /** Operator symbols to register as `(Self, Self): bool`. */
  readonly comparisons?: readonly string[];
  /** Conversion signatures, e.g. `string(Self): string`. */
  readonly conversions?: readonly string[];
  /** Member signatures, e.g. `Self.scaled(int): Self`. */
  readonly members?: readonly string[];
  readonly description?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const PARAMETER = /^[A-Z]$/;
const LANGUAGE_NAMES = new Set([
  "dyn",
  "int",
  "uint",
  "double",
  "bool",
  "string",
  "bytes",
  "null",
  "null_type",
  "type",
  "list",
  "map",
  "optional",
  "timestamp",
  "duration",
]);

export class CelTypeRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelTypeRegistrationError";
  }
}

/** A registered nominal type: its definition, its base, and the type `Self` names. */
export interface RegisteredType {
  readonly definition: NominalTypeDefinition;
  readonly base: CelType;
  readonly parameters: readonly string[];
  /** The type with its own parameters applied — what `Self` resolves to. */
  readonly self: NominalType;
}

export function validateTypeName(name: string): void {
  if (!NAME.test(name)) {
    throw new CelTypeRegistrationError(`${JSON.stringify(name)} is not spelled as a type name`);
  }
  if (LANGUAGE_NAMES.has(name)) {
    throw new CelTypeRegistrationError(`${JSON.stringify(name)} is a type of the language and cannot be redefined`);
  }
  if (PARAMETER.test(name)) {
    throw new CelTypeRegistrationError(
      `${JSON.stringify(name)} is a single capital letter, which a signature reads as a type parameter`,
    );
  }
}

/**
 * Builds the registered form of a definition. `resolveNominal` resolves names the
 * definition's own base or members mention, including itself through `Self`.
 */
export function buildRegisteredType(
  definition: NominalTypeDefinition,
  resolveNominal: NominalResolver,
): RegisteredType {
  validateTypeName(definition.name);
  const parameters = definition.parameters ?? [];
  for (const parameter of parameters) {
    if (!PARAMETER.test(parameter)) {
      throw new CelTypeRegistrationError(
        `type parameter ${JSON.stringify(parameter)} of ${definition.name} must be a single capital letter`,
      );
    }
  }
  const self: NominalType = {
    kind: "nominal",
    name: definition.name,
    base: { kind: "dyn" },
    args: parameters.map(parameterOf),
  };
  const withSelf: NominalResolver = (name, args) =>
    name === "Self" || name === definition.name
      ? { ...self, args: args.length > 0 ? args : self.args }
      : resolveNominal(name, args);
  let base: CelType;
  try {
    base = parseTypeExpression(definition.base, withSelf);
  } catch (cause) {
    throw new CelTypeRegistrationError(
      `the base of ${definition.name} does not read as a type: ${(cause as Error).message}`,
    );
  }
  return { definition, base, parameters, self: { ...self, base } };
}

/** The signatures a definition declares, as text, in registration order. */
export function nominalSignatures(definition: NominalTypeDefinition): readonly string[] {
  return [...(definition.conversions ?? []), ...(definition.members ?? [])];
}

/** The operator declarations a definition implies, its comparisons expanded. */
export function nominalOperators(definition: NominalTypeDefinition): readonly NominalOperatorDeclaration[] {
  const comparisons = (definition.comparisons ?? []).map((operator) => ({
    operator,
    parameters: ["Self", "Self"],
    returns: "bool",
  }));
  return [...(definition.operators ?? []), ...comparisons];
}
