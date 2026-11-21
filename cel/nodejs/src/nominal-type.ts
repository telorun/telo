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
import type { CelValue } from "./cel-value.js";
import type { CelCallContext } from "./runtime-library.js";
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
  /**
   * The fields a value of the type carries, by name, each a type expression. A field is
   * read by `.`, `.?` and `has()`; a name the definition does not declare is an unknown
   * field. A value of the type holds them as its OWN entries, beside its type key, and
   * the member-read seam answers no other entry of it.
   */
  readonly fields?: Readonly<Record<string, string>>;
  /**
   * Whether an expression may build a value of the type from its fields — `Name{field: v}`.
   * The type must declare `fields` (an empty set is a type with none) and no `parameters`.
   * Its values then compare field by field, and no `==` or `!=` a host registers may compare
   * them instead.
   */
  readonly constructible?: boolean;
  /** The fields a construction must write; each one the type declares, on a constructible type only. */
  readonly required?: readonly string[];
  readonly description?: string;
}

/**
 * Builds a value of a constructible type from the fields a construction wrote, unset ones
 * left out: a value of the type, or a CEL error value refusing them. The call context comes
 * first, as a registered implementation's does, so `ctx.range` is the construction's.
 */
export type CelConstruct = (ctx: CelCallContext, fields: Readonly<Record<string, CelValue>>) => CelValue;

/** What a host supplies with a type beside its definition. */
export interface RegisterTypeOptions {
  /** The builder of a constructible type's values; without one the engine builds them itself. */
  readonly construct?: CelConstruct;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  /** The names of its declared fields, for the member-read seam; absent when it declares none. */
  readonly fieldNames?: ReadonlySet<string>;
  /** Whether an expression may construct a value of it. */
  readonly constructible: boolean;
  /** The fields a construction must write, in the order the definition lists them. */
  readonly required: readonly string[];
  /** The host's builder, where it supplied one. */
  readonly construct?: CelConstruct;
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
  options: RegisterTypeOptions = {},
): RegisteredType {
  validateTypeName(definition.name);
  validateConstruction(definition, options);
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
  const fields = definition.fields === undefined ? undefined : readFields(definition, withSelf);
  return {
    definition,
    base,
    parameters,
    self: { ...self, base, ...(fields ? { fields } : {}) },
    ...(fields ? { fieldNames: new Set(fields.keys()) } : {}),
    constructible: definition.constructible === true,
    required: [...new Set(definition.required ?? [])],
    ...(options.construct ? { construct: options.construct } : {}),
  };
}

/**
 * What a constructible type must be: one with fields to write and no type parameters, the
 * syntax having no place for a type argument. A required field must be a declared one of a
 * type that can be constructed, and so must a builder.
 */
function validateConstruction(definition: NominalTypeDefinition, options: RegisterTypeOptions): void {
  const { name } = definition;
  if (definition.constructible === true) {
    if (definition.fields === undefined) {
      throw new CelTypeRegistrationError(
        `${name} is constructible and declares no fields; declare \`fields\`, an empty set for a type with none`,
      );
    }
    if ((definition.parameters ?? []).length > 0) {
      throw new CelTypeRegistrationError(
        `${name} is constructible and takes type parameters, which a construction has no place to write`,
      );
    }
  } else if ((definition.required ?? []).length > 0) {
    throw new CelTypeRegistrationError(`${name} lists required fields and is not constructible`);
  }
  for (const field of definition.required ?? []) {
    if (definition.fields === undefined || !Object.prototype.hasOwnProperty.call(definition.fields, field)) {
      throw new CelTypeRegistrationError(`required field ${JSON.stringify(field)} of ${name} is not one of its fields`);
    }
  }
  if (options.construct !== undefined && definition.constructible !== true) {
    throw new CelTypeRegistrationError(`${name} is given a builder and is not constructible`);
  }
}

function readFields(definition: NominalTypeDefinition, resolve: NominalResolver): ReadonlyMap<string, CelType> {
  const fields = new Map<string, CelType>();
  for (const [name, text] of Object.entries(definition.fields!)) {
    if (!FIELD.test(name)) {
      throw new CelTypeRegistrationError(`field ${JSON.stringify(name)} of ${definition.name} is not spelled as a name`);
    }
    try {
      fields.set(name, parseTypeExpression(text, resolve));
    } catch (cause) {
      throw new CelTypeRegistrationError(
        `field ${JSON.stringify(name)} of ${definition.name} does not read as a type: ${(cause as Error).message}`,
      );
    }
  }
  return fields;
}

/** The signatures a definition declares, as text, in registration order. */
export function nominalSignatures(definition: NominalTypeDefinition): readonly string[] {
  return [...(definition.conversions ?? []), ...(definition.members ?? [])];
}

/**
 * The operator declarations a definition implies, its comparisons expanded. A constructible
 * type is compared by `==` and `!=` whether or not it lists them: its values are its fields,
 * which the engine's equality compares.
 */
export function nominalOperators(definition: NominalTypeDefinition): readonly NominalOperatorDeclaration[] {
  const listed = [...(definition.constructible === true ? ["==", "!="] : []), ...(definition.comparisons ?? [])];
  const comparisons = [...new Set(listed)].map((operator) => ({
    operator,
    parameters: ["Self", "Self"],
    returns: "bool",
  }));
  return [...(definition.operators ?? []), ...comparisons];
}
