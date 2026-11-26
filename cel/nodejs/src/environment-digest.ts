/**
 * The digest of an environment — one of the four things an emitted module's cache key is
 * over.
 *
 * It is taken over the environment's **resolved listing**, never over its registration
 * history: a function registered and then replaced leaves one entry, and two environments
 * built by different orders of the same registrations are the same environment. Keying on
 * the history instead would fragment the cache into one entry per way of arriving at the
 * same answers, which is the same defect as a key that is too narrow wearing the other
 * face.
 *
 * So every line below is a fact about what the environment *is*: every function signature
 * surviving registration and removal, every named type with its base, parameters, fields and
 * construction, every variable with its name and its type's whole structure (a record's
 * fields, undeclared and absent members, each field's finite set, a tuple's positions and rest), every namespace with the functions it
 * declares and the structure of each result it declares as a schema, and every option value. The lines are sorted, so the order they were produced in cannot
 * reach the digest.
 *
 * **What the digest is for, in this engine.** Overloads are resolved at evaluation on the
 * values' own types (`backend-runtime.ts`), so a replaced library does not change the
 * emitted *text* the way it would in an engine that baked a resolution into the output.
 * What it changes is the runtime object the module is handed — and the module's integrity
 * header repeats this digest, so a module can only ever be run against the environment it
 * was written for. The wide key is therefore what makes the header a proof rather than a
 * hope, and over-keying is the safe direction: a key too wide costs a recompile, a key too
 * narrow runs the wrong code.
 *
 * **One limit, written down rather than hidden:** an option written explicitly as its own
 * default is a different line from one left out, so a host that passes
 * `standardLibrary: true` and a host that relies on the default are two cache entries for
 * one environment. Normalizing that would mean teaching this file every option's default —
 * a second copy of what the constructor already decides, and the kind of copy that drifts.
 * The cost is one extra emission; the cost of the copy going stale is a wrong key.
 */

import type { CelType, FieldEnumValue } from "./cel-type.js";
import type { CelEnvironmentOptions, Definitions } from "./environment.js";
import { sha256OfText } from "./sha256.js";
import { countTypeVisit } from "./type-visits.js";

/** What the digest reads of an environment — its listing and its options, nothing else. */
export interface DigestedEnvironment {
  definitions(): Definitions;
  readonly options: CelEnvironmentOptions;
}

/** JSON with every object's keys in order, so two equal values are one text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as object)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * How one option contributes. A **function**-valued option (the schema resolver) is
 * recorded as present rather than inspected: its answers are already in the variable types
 * the listing carries, which is the resolved form of exactly what it decided. An option
 * nothing supplied and one supplied as `undefined` are one environment, so both read
 * `absent`.
 */
function optionText(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "function") return "present";
  return canonicalJson(value);
}

/** Every line of the environment's resolved listing, canonically sorted. */
export function environmentListing(environment: DigestedEnvironment): readonly string[] {
  const definitions = environment.definitions();
  const lines: string[] = [];
  for (const key of Object.keys(environment.options)) {
    lines.push(`option ${key} ${optionText((environment.options as Record<string, unknown>)[key])}`);
  }
  for (const variable of definitions.variables) {
    lines.push(`variable ${variable.name} ${typeStructure(variable.type)} ${variable.constant}`);
  }
  for (const held of definitions.functions) {
    lines.push(
      [
        "function",
        held.signature,
        held.receiverType ?? "-",
        held.deterministic,
        held.hostBacked,
        canonicalJson(held.throws ?? null),
        held.origin ?? "-",
      ].join(" "),
    );
  }
  for (const held of definitions.types) {
    // A field decides whether a read of it checks clean, and whether a type is constructible,
    // what it requires and who builds it decide what a construction answers, so two
    // environments differing only in one of them must not share an emitted module.
    lines.push(
      `type ${held.name} ${held.base} ${canonicalJson(held.parameters)} ${canonicalJson(held.fields ?? null)} ${canonicalJson(held.constructible ?? null)}`,
    );
  }
  for (const held of definitions.namespaces) {
    // Openness is part of the surface, not a convenience: it decides whether an undeclared
    // name checks clean, so two environments differing only in it answer differently and must
    // not share an emitted module.
    const declarations = held.functions.map((listed) => listed.declaration);
    lines.push(`namespace ${held.name} ${held.open ? "open" : "closed"} ${canonicalJson(declarations.sort(compareText))}`);
    // A result declared as a schema prints cut, so its listed text does not identify it:
    // its structure does.
    for (const listed of held.functions) {
      if (listed.resultType === undefined) continue;
      lines.push(`namespace-result ${held.name} ${JSON.stringify(listed.declaration)} ${typeStructure(listed.resultType)}`);
    }
  }
  return lines.sort(compareText);
}

/**
 * A type written whole, where its printed name is not: a record's fields in name order with
 * its absent members, its patterns in text order and its undeclared members, a tuple's
 * positions and rest. A type object met again
 * is written as `@<n>`, its order of first appearance, so a shape shared a hundred times is
 * written once.
 */
function typeStructure(root: CelType): string {
  const seen = new Map<CelType, number>();
  const write = (type: CelType): string => {
    countTypeVisit();
    const leaf = type.kind === "dyn" || type.kind === "primitive" || type.kind === "parameter";
    const held = seen.get(type);
    if (held !== undefined) return `@${held}`;
    if (!leaf) seen.set(type, seen.size);
    switch (type.kind) {
      case "dyn":
        return "dyn";
      case "primitive":
        return type.name;
      case "parameter":
        return `'${type.name}`;
      case "list": {
        const element = `list<${write(type.element)}`;
        if (!type.prefixElements) return `${element}>`;
        const rest = type.additionalElements === undefined ? "" : ` ...${write(type.additionalElements)}`;
        return `${element} [${type.prefixElements.map(write).join(",")}]${rest}>`;
      }
      case "map":
        return `map<${write(type.key)},${write(type.value)}>`;
      case "optional":
        return `optional<${write(type.value)}>`;
      case "union":
        return `(${type.members.map(write).join("|")})`;
      case "nominal":
        return `${JSON.stringify(type.name)}<${type.args.map(write).join(",")}>`;
      case "record": {
        const fields = [...type.fields.keys()].sort(compareText).map((name) => `${JSON.stringify(name)}:${write(type.fields.get(name)!)}`);
        const absent = [...(type.absentFields ?? [])].sort(compareText).map((name) => `-${JSON.stringify(name)}`);
        const enums = [...(type.fieldEnums ?? [])]
          .sort(([left], [right]) => compareText(left, right))
          .map(([name, values]) => `=${JSON.stringify(name)}:[${values.map(enumValueText).join(",")}]`);
        const patterns = (type.patternParts ?? [])
          .map((part) => {
            const entries = [...part.fields]
              .sort((left, right) => compareText(left.pattern, right.pattern))
              .map((entry) => `/${JSON.stringify(entry.pattern)}:${entry.type === undefined ? "-" : write(entry.type)}`);
            const additional = part.additionalFields === undefined ? [] : [`...${write(part.additionalFields)}`];
            return `[${[...entries, ...additional].join(",")}]`;
          })
          .sort(compareText);
        const additional = type.additionalFields === undefined ? [] : [`...${write(type.additionalFields)}`];
        return `${type.name === undefined ? "" : JSON.stringify(type.name)}{${[...fields, ...absent, ...enums, ...patterns, ...additional].join(",")}}`;
      }
    }
  };
  return write(root);
}

/** A value of a field's set, its type written beside it: a set is already in canonical order. */
function enumValueText(value: FieldEnumValue): string {
  if (typeof value === "bigint") return `i${value}`;
  if (typeof value === "number") return `d${value}`;
  return JSON.stringify(value);
}

/** The digest of an environment: 64 hexadecimal characters over its sorted listing. */
export function environmentDigest(environment: DigestedEnvironment): string {
  return sha256OfText(environmentListing(environment).join("\n"));
}
