/**
 * What a construction `Name{field: value, …}` names, and every refusal of one — decided
 * once, for the checker and both backends.
 *
 * A construction's name is resolved against the **registered types alone**, by its whole
 * dotted text: no variable, binding or container takes part, so `.Name{…}` names exactly
 * what `Name{…}` does. Only a type that opted in with `constructible` is built; a language
 * type, a well-known type and a registered type without the opt-in are refused, each in
 * its own words, and a name nothing registers is unknown whatever the environment says
 * about undeclared variables — nothing can be constructed from `dyn`.
 *
 * The checker reports a refusal as a diagnostic and a backend answers it as an error value
 * at evaluation, with the same sentence, because both read it here.
 */

import type { CelType, NominalType } from "./cel-type.js";
import { formatType, WELL_KNOWN_TYPE_NAMES } from "./cel-type.js";
import type { RegisteredFunction } from "./function-registry.js";
import { nearestCandidates } from "./function-registry.js";
import type { RegisteredType } from "./nominal-type.js";
import type { CelSignature } from "./signature.js";
import { signatureKey } from "./signature.js";

/** What resolving a construction reads of an environment. */
export interface ConstructionTypes {
  /** The type registered under a name, if any. */
  readonly registeredType: (name: string) => RegisteredType | undefined;
  /** Every registered type, for naming the constructible ones a misspelling was near. */
  readonly registeredTypes: () => readonly RegisteredType[];
  /** The names the language gives its own types (`int`, `list`, …). */
  readonly languageTypeNames: ReadonlySet<string>;
  /** Every registered function, for naming where a value of a type comes from. */
  readonly functions: () => readonly CelSignature[];
}

/**
 * The protobuf well-known messages, which a protobuf type provider would build and this
 * engine has none of. `google.protobuf.NullValue` is an enum, not a message.
 */
const PROTOBUF_MESSAGES: ReadonlySet<string> = new Set(
  [
    "Any",
    "BoolValue",
    "BytesValue",
    "DoubleValue",
    "Duration",
    "Empty",
    "FieldMask",
    "FloatValue",
    "Int32Value",
    "Int64Value",
    "ListValue",
    "StringValue",
    "Struct",
    "Timestamp",
    "UInt32Value",
    "UInt64Value",
    "Value",
  ].map((name) => `google.protobuf.${name}`),
);

export type ConstructionRefusalCode ="CEL_UNKNOWN_TYPE" | "CEL_TYPE_NOT_CONSTRUCTIBLE";

export interface ConstructionRefusal {
  readonly code: ConstructionRefusalCode;
  readonly message: string;
}

/** The type a construction builds, or why it builds none. */
export type ConstructionTarget =
  | { readonly type: RegisteredType; readonly refusal?: never }
  | { readonly refusal: ConstructionRefusal; readonly type?: never };

export function constructionTarget(name: string, types: ConstructionTypes): ConstructionTarget {
  const registered = types.registeredType(name);
  if (registered?.constructible) return { type: registered };
  if (registered) {
    return {
      refusal: {
        code: "CEL_TYPE_NOT_CONSTRUCTIBLE",
        message: `${JSON.stringify(name)} is a registered type that does not allow construction${producers(name, types)}`,
      },
    };
  }
  if (types.languageTypeNames.has(name)) {
    return {
      refusal: {
        code: "CEL_TYPE_NOT_CONSTRUCTIBLE",
        message: `${JSON.stringify(name)} is a language type and has no fields; write a literal or a conversion`,
      },
    };
  }
  if (PROTOBUF_MESSAGES.has(name)) {
    const wellKnown = WELL_KNOWN_TYPE_NAMES[name];
    return {
      refusal: {
        code: "CEL_TYPE_NOT_CONSTRUCTIBLE",
        message: `${JSON.stringify(name)} is a protobuf message and no protobuf type provider is present${
          wellKnown === undefined ? "" : `; write ${wellKnown}(…) instead`
        }`,
      },
    };
  }
  const constructible = types
    .registeredTypes()
    .filter((type) => type.constructible)
    .map((type) => type.definition.name);
  const nearest = nearestCandidates(name, constructible, (candidate) => candidate);
  return {
    refusal: {
      code: "CEL_UNKNOWN_TYPE",
      message: `no type named ${JSON.stringify(name)} is registered${
        nearest.length === 0 ? "" : ` — the closest constructible: ${nearest.join(", ")}`
      }`,
    },
  };
}

/** Where a value of a type that cannot be constructed comes from: the functions answering one. */
function producers(name: string, types: ConstructionTypes): string {
  const returning = types
    .functions()
    .filter((signature) => signature.returns.kind === "nominal" && signature.returns.name === name);
  const nearest = nearestCandidates(name, returning, (signature) => signature.name, signatureKey);
  if (nearest.length === 0) return "";
  return ` — the closest functions returning it: ${nearest.map(signatureKey).join(", ")}`;
}

/** A field the type does not declare — the same sentence a read of one is refused with. */
export function unknownFieldMessage(type: NominalType, field: string): string {
  return `${JSON.stringify(field)} is not a field of ${formatType(type)} (fields: ${[...type.fields!.keys()].join(", ")})`;
}

export function duplicateFieldMessage(type: NominalType, field: string): string {
  return `field ${JSON.stringify(field)} of ${formatType(type)} is written more than once`;
}

/** The first field a construction writes that its type refuses, in source order. */
export function writtenFieldRefusal(
  type: NominalType,
  fields: readonly string[],
): { readonly at: number; readonly message: string } | undefined {
  const seen = new Set<string>();
  for (const [at, field] of fields.entries()) {
    if (seen.has(field)) return { at, message: duplicateFieldMessage(type, field) };
    seen.add(field);
    if (!type.fields!.has(field)) return { at, message: unknownFieldMessage(type, field) };
  }
  return undefined;
}

/** A written field value whose runtime type the field's declared type does not admit. */
export function fieldValueRefusalMessage(type: NominalType, field: string, declared: CelType, held: string | undefined): string {
  const value = held === undefined ? "is of no CEL type" : `is ${held}`;
  return `field ${JSON.stringify(field)} of ${formatType(type)} is ${formatType(declared)}, and this value ${value}`;
}

// --- equality over a constructible type -----------------------------------

/**
 * The constructible type an `==` or `!=` registration would compare values of, first by
 * name in code-unit order: a type either parameter accepts at top level — the type itself,
 * `dyn`, a bare type parameter, or a union with a member that does. A container parameter
 * is not read inside. Such a registration is refused, because a constructible type's
 * equality is its fields' and nothing a host registers may answer it instead.
 */
export function comparedConstructible(
  signature: CelSignature,
  constructible: readonly string[],
): string | undefined {
  if (signature.form !== "global" || (signature.name !== "==" && signature.name !== "!=")) return undefined;
  if (signature.parameters.length !== 2) return undefined;
  return [...constructible]
    .sort(compareCodeUnits)
    .find((name) => signature.parameters.some((parameter) => acceptsAtTop(parameter, name)));
}

function acceptsAtTop(parameter: CelType, name: string): boolean {
  switch (parameter.kind) {
    case "dyn":
    case "parameter":
      return true;
    case "nominal":
      return parameter.name === name;
    case "union":
      return parameter.members.some((member) => acceptsAtTop(member, name));
    default:
      return false;
  }
}

/** Whether a registration is one of the `(Self, Self)` comparisons a type declares of itself. */
export function isOwnComparison(entry: RegisteredFunction, name: string): boolean {
  return (
    entry.metadata.origin === `type:${name}` &&
    entry.signature.parameters.length === 2 &&
    entry.signature.parameters.every((parameter) => parameter.kind === "nominal" && parameter.name === name)
  );
}

/**
 * The registration, first by signature key in code-unit order, that would compare values of
 * `name` — every `==` and `!=` but the comparisons the type declares of itself.
 */
export function equalityComparing(registrations: readonly RegisteredFunction[], name: string): CelSignature | undefined {
  return registrations
    .filter((entry) => !isOwnComparison(entry, name) && comparedConstructible(entry.signature, [name]) !== undefined)
    .map((entry) => entry.signature)
    .sort((left, right) => compareCodeUnits(signatureKey(left), signatureKey(right)))[0];
}

export function equalityRegistrationRefusal(signature: CelSignature, type: string): string {
  return `${signatureKey(signature)} cannot be registered: it would compare values of ${type}, which is constructible, and a constructible type's values are equal exactly when their fields are; normalise the fields in its builder, or register ${type} without constructible`;
}

export function constructibleEqualityRefusal(type: string, signature: CelSignature): string {
  return `${type} cannot be constructible: ${signatureKey(signature)} is registered and would compare its values, and a constructible type's values are equal exactly when their fields are`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
