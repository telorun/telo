/**
 * A host for an emitted module, and the one canonical form the two backends' answers are
 * compared in.
 *
 * The engine exports no loader and touches no filesystem, so loading is the host's half —
 * and a test is a host. This one loads from a **`data:` URL**: no disk, no `eval`, no store,
 * and no path outside this package. It is also the load that proves the injection rule, since
 * a `data:` URL cannot resolve a bare specifier at all — a module that imported
 * `@telorun/cel` would simply not load here. Node reads one of 1.75 MB (2,000 expressions)
 * in about 135 ms, so the conformance replay's whole-file module loads this way too.
 *
 * The text is base64'd with `btoa`, which **throws on any character outside Latin-1** — so
 * the emitter's promise that an emitted module is pure ASCII, whatever its expressions were
 * written in, is asserted by every load rather than by a test of its own.
 *
 * It lives here rather than in each gate because the identity gate and the conformance
 * identity replay must load a module **the same way**: two loaders would be two answers to
 * "what did the module answer", and the whole point of the comparison is that there is one.
 */

import {
  CelEvaluationError,
  doubleText,
  formatDuration,
  formatTimestamp,
  isCelBytes,
  isCelDuration,
  isCelError,
  isCelMap,
  isCelOptional,
  isCelRecord,
  isCelTimestamp,
  isCelTypeValue,
  isCelUint,
  programsFromEmittedModule,
  type CelActivation,
  type CelEnvironment,
  type CelProgram,
  type EmittedModule,
  type EvaluateOptions,
} from "../src/index.js";

/**
 * The programs an emitted module answers, loaded and **verified**: the header is checked
 * against the emission before a single function is run, which is what makes a wrong hit a
 * recompile rather than a run.
 */
export async function loadEmittedPrograms(
  environment: CelEnvironment,
  module: EmittedModule,
): Promise<readonly CelProgram[]> {
  const loaded = (await import(`data:text/javascript;base64,${btoa(module.text)}`)) as {
    readonly integrity?: unknown;
    readonly default?: unknown;
  };
  return programsFromEmittedModule(loaded, module, environment.emitterRuntime());
}

/** The emitted programs for a set of sources, in the order the sources were given. */
export async function emittedPrograms(
  environment: CelEnvironment,
  sources: readonly string[],
): Promise<readonly CelProgram[]> {
  return loadEmittedPrograms(environment, environment.emit(sources));
}

/**
 * What a program answered, as one text.
 *
 * A text rather than a value, and a **canonical** one: a difference of CEL type is a
 * difference of text (an int, a uint and a double never write alike), `NaN` and `-0` are
 * named, and a failure is written as its code and its range — so "the two backends answer
 * identically" is one string comparison and not a deep-equality that would quietly accept
 * `1` for `1u` or `0` for `-0`.
 */
export function answerText(
  program: CelProgram,
  activation?: CelActivation,
  options?: EvaluateOptions,
): string {
  try {
    return `value ${written(program.evaluate(activation, options))}`;
  } catch (cause) {
    if (cause instanceof CelEvaluationError) {
      return `error ${cause.code} [${cause.range?.join(", ") ?? "-"}]`;
    }
    return `threw ${(cause as Error).name}: ${(cause as Error).message}`;
  }
}

/** Every value this engine can answer, written one way. Total, errors and host values too. */
export function written(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return `bool ${value}`;
    case "string":
      return `string ${JSON.stringify(value)}`;
    case "number":
      return `double ${doubleText(value)}`;
    case "bigint":
      return `int ${value}`;
    case "object":
      break;
    default:
      return `outside the domain: ${typeof value}`;
  }
  if (isCelUint(value)) return `uint ${value.value}`;
  if (isCelTimestamp(value)) return `timestamp ${formatTimestamp(value)}`;
  if (isCelDuration(value)) return `duration ${formatDuration(value)}`;
  if (isCelTypeValue(value)) return `type ${value.name}`;
  if (isCelOptional(value)) {
    return value.present ? `optional(${written(value.held)})` : "optional()";
  }
  if (isCelError(value)) return `error ${value.code} [${value.range?.join(", ") ?? "-"}]`;
  if (isCelBytes(value)) {
    return `bytes ${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  if (Array.isArray(value)) return `list(${value.map(written).join(", ")})`;
  if (isCelMap(value)) {
    // Insertion order, deliberately: both backends build a map's entries in written order,
    // so comparing the order is stricter than sorting it would be.
    return `map(${[...value.entries.values()]
      .map((entry) => `${written(entry.key)}: ${written(entry.value)}`)
      .join(", ")})`;
  }
  if (typeof (value as { then?: unknown }).then === "function") return "thenable";
  if (isCelRecord(value)) {
    return `record(${Object.keys(value)
      .map((key) => `${key}: ${written(value[key])}`)
      .join(", ")})`;
  }
  return `host ${Object.prototype.toString.call(value)}`;
}
