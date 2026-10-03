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
 * surviving registration and removal, every named type with its base and parameters, every
 * variable with its name and type, every namespace with the functions it declares, and
 * every option value. The lines are sorted, so the order they were produced in cannot
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

import type { CelEnvironmentOptions, Definitions } from "./environment.js";
import { sha256OfText } from "./sha256.js";

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
    lines.push(`variable ${variable.name} ${variable.typeName} ${variable.constant}`);
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
    lines.push(`type ${held.name} ${held.base} ${canonicalJson(held.parameters)}`);
  }
  for (const held of definitions.namespaces) {
    // Openness is part of the surface, not a convenience: it decides whether an undeclared
    // name checks clean, so two environments differing only in it answer differently and must
    // not share an emitted module.
    lines.push(
      `namespace ${held.name} ${held.open ? "open" : "closed"} ${canonicalJson([...held.functions].sort(compareText))}`,
    );
  }
  return lines.sort(compareText);
}

/** The digest of an environment: 64 hexadecimal characters over its sorted listing. */
export function environmentDigest(environment: DigestedEnvironment): string {
  return sha256OfText(environmentListing(environment).join("\n"));
}
