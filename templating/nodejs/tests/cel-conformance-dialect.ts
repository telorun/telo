/**
 * A dialect row driven through its tag engine's own seams: `analyze` in the
 * dialect environment with the nominal brands, the row's declarations and its
 * JSON Schema inputs; then `compile` and evaluate without them, a row's module
 * functions bound as the dispatch table.
 */
import type { Environment } from "@marcbachmann/cel-js";
import { encodeTypedFrame, RuntimeError, Stream } from "@telorun/sdk";
import { builtinEngines } from "../src/builtins.js";
import { CEL_FUNCTIONS, type CelHandlers } from "../src/cel/catalog.js";
import { buildCelLanguageEnvironment, deriveSignatures } from "../src/cel/environment.js";
import { MODULE_CALL_DISPATCH_KEY, type ModuleCallDispatch } from "../src/cel/module-call.js";
import { registerValueBrands } from "../src/cel/value-brands.js";
import type { AnalyzeEnv, TemplatingEngine } from "../src/engine.js";
import { conformanceError, type ConformanceError, type ConformanceFunction } from "./cel-conformance-language.js";
import type { ConformanceValue, ConformanceValueCodec } from "./cel-conformance-value.js";

/** A cel-js type string, or a record whose fields are declarations in turn. */
export type Declaration = string | { fields: Record<string, Declaration> };

/** A module function as the host answers for it, and what it does when dispatched. */
export interface ModuleFunction {
  returns: string;
  deterministic: boolean;
  hostBacked: boolean;
  resultSchema?: Record<string, unknown>;
  result?: ConformanceValue;
  error?: ConformanceError;
}

export interface DialectModules {
  names: string[];
  functions?: Record<string, ModuleFunction>;
}

export interface DialectDispatch {
  name: string;
  arguments: ConformanceValue[];
}

export interface DialectRow {
  id: string;
  tag: string;
  source: string;
  declarations?: Record<string, Declaration>;
  functions?: ConformanceFunction[];
  bindings?: Record<string, ConformanceValue>;
  context?: Record<string, unknown>;
  explain?: Record<string, unknown>;
  rootsDeclared?: true;
  couldNameModule?: string[];
  modules?: DialectModules;
  expect: DialectExpect;
}

export interface DialectDiagnostic {
  code: string | null;
  message: string;
  fix?: { replacement: string };
}

export interface DialectCall {
  name: string;
  form: "global" | "receiver";
  moduleCall?: true;
  arity: number;
  arguments?: { type?: string; chain?: string[] }[];
  start: number;
  end: number;
  deterministic?: boolean;
  hostBacked?: boolean;
}

export interface DialectCheck {
  diagnostics: DialectDiagnostic[];
  type?: string;
  calls: DialectCall[];
  stringLiteral?: string;
  readTypes?: string[];
  regions: { start: number; end: number }[];
  refs?: string[];
  volatile?: boolean;
}

export interface DialectExpect {
  check: DialectCheck;
  dispatched?: DialectDispatch[];
  value?: ConformanceValue;
  error?: ConformanceError;
}

/** The tags a dialect row may name. */
export const DIALECT_TAGS = ["cel", "interpolate", "sql"];

/** A row whose evaluation handed a conformance handler a value the typed frame
 *  cannot write: the handler set is not defined over it, so the row has no answer. */
export class MalformedRowError extends Error {}

const handlerRefusals: MalformedRowError[] = [];

function frameArgs(name: string, args: unknown[]): string {
  try {
    return `${name}(${args.map((arg) => encodeTypedFrame(arg)).join(", ")})`;
  } catch (cause) {
    const refusal = new MalformedRowError(
      `the handler '${name}' was handed a value the typed frame cannot write (${(cause as Error).message})`,
      { cause },
    );
    handlerRefusals.push(refusal);
    throw refusal;
  }
}

/** The conformance handler set: each host handler answers with its own name and
 *  the typed-frame text of every argument it was handed. It is defined only over
 *  values the typed frame writes. */
export const CONFORMANCE_HANDLERS: CelHandlers = {
  sha256: (...args) => frameArgs("sha256", args),
  md5: (...args) => frameArgs("md5", args),
  sha1: (...args) => frameArgs("sha1", args),
  sha512: (...args) => frameArgs("sha512", args),
  hmac: (...args) => frameArgs("hmac", args),
  base64Encode: (...args) => frameArgs("base64Encode", args),
  base64Decode: (...args) => frameArgs("base64Decode", args),
  json: (...args) => frameArgs("json", args),
  joinPath: (...args) => frameArgs("joinPath", args),
};

/** Every overload the catalog registers, by its cel-js registration signature. */
export function catalogOverloads(): { name: string; signature: string }[] {
  return CEL_FUNCTIONS.flatMap((fn) =>
    (fn.register ?? deriveSignatures(fn.signature)).map((signature) => ({ name: fn.name, signature })),
  );
}

/** The dialect environment registered overload by overload, each reporting its
 *  own dispatch — how a runner learns which overload a row reached. The runner
 *  holds it to `buildCelEnvironment`'s definitions, so it cannot drift. */
export function dispatchTracingEnvironment(
  handlers: CelHandlers,
  dispatched: (signature: string) => void,
): Environment {
  let env = buildCelLanguageEnvironment();
  for (const fn of CEL_FUNCTIONS) {
    const impl = fn.build(handlers);
    for (const signature of fn.register ?? deriveSignatures(fn.signature)) {
      env = env.registerFunction(signature, (...args: unknown[]) => {
        dispatched(signature);
        return impl(...args);
      });
    }
  }
  return env.registerType("Stream", Stream as unknown as new (...args: unknown[]) => unknown);
}

function engineOf(tag: string): TemplatingEngine {
  const engine = DIALECT_TAGS.includes(tag) ? builtinEngines.find((e) => e.name === tag) : undefined;
  if (!engine) throw new Error(`No dialect engine drives the tag '${tag}'`);
  return engine;
}

function objectSchemaOf(fields: Record<string, Declaration>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [name, typeof type === "string" ? type : objectSchemaOf(type.fields)]),
  );
}

function withFunctions(env: Environment, row: DialectRow, codec: ConformanceValueCodec): Environment {
  const cloned = env.clone();
  for (const fn of row.functions ?? []) {
    cloned.registerFunction(fn.signature, () => {
      if ("error" in fn) throw new Error(fn.error);
      return codec.decode(fn.result);
    });
  }
  return cloned;
}

function staticEnvironment(env: Environment, row: DialectRow, codec: ConformanceValueCodec): Environment {
  const cloned = env.clone();
  registerValueBrands(cloned);
  for (const [name, type] of Object.entries(row.declarations ?? {})) {
    if (typeof type === "string") cloned.registerVariable(name, type);
    else (cloned as any).registerVariable({ name, schema: objectSchemaOf(type.fields) });
  }
  return withFunctions(cloned, row, codec);
}

const moduleFunctionOf = (modules: DialectModules, qualified: string): ModuleFunction | undefined =>
  modules.functions && Object.hasOwn(modules.functions, qualified) ? modules.functions[qualified] : undefined;

function analyzeEnvOf(celEnv: Environment, row: DialectRow): AnalyzeEnv {
  const explain = row.explain;
  const couldNameModule = row.couldNameModule;
  const modules = row.modules;
  return {
    celEnv,
    contextSchema: row.context ?? null,
    ...(row.rootsDeclared ? { rootsDeclared: true } : {}),
    ...(explain ? { explainSchema: () => explain } : {}),
    ...(couldNameModule ? { couldNameModule: (name: string) => couldNameModule.includes(name) } : {}),
    ...(modules
      ? {
          moduleNames: new Set(modules.names),
          moduleCallType: (qualified: string) => moduleFunctionOf(modules, qualified)?.returns,
          moduleCallResult: (qualified: string) => moduleFunctionOf(modules, qualified)?.resultSchema,
          moduleCallFlags: (qualified: string) => {
            const fn = moduleFunctionOf(modules, qualified);
            return fn && { deterministic: fn.deterministic, hostBacked: fn.hostBacked };
          },
        }
      : {}),
  };
}

/** The static half: what the tag engine's `analyze` answers, plus the regions it
 *  reports. */
export function analyzeDialectRow(
  env: Environment,
  codec: ConformanceValueCodec,
  row: DialectRow,
): DialectCheck {
  const engine = engineOf(row.tag);
  const result = engine.analyze(row.source, analyzeEnvOf(staticEnvironment(env, row, codec), row));
  return {
    diagnostics: result.diagnostics.map((d) => ({
      code: d.code ?? null,
      message: d.message,
      ...(d.fix ? { fix: { replacement: d.fix.replacement } } : {}),
    })),
    ...(result.type === undefined ? {} : { type: result.type }),
    calls: result.calls.map((call) => ({
      name: call.name,
      form: call.form,
      ...(call.moduleCall ? { moduleCall: true as const } : {}),
      arity: call.arity,
      ...(call.arguments
        ? {
            arguments: call.arguments.map((arg) => ({
              ...(arg.type === undefined ? {} : { type: arg.type }),
              ...(arg.chain === undefined ? {} : { chain: [...arg.chain] }),
            })),
          }
        : {}),
      start: call.start,
      end: call.end,
      ...(call.deterministic === undefined ? {} : { deterministic: call.deterministic }),
      ...(call.hostBacked === undefined ? {} : { hostBacked: call.hostBacked }),
    })),
    ...(result.stringLiteral === undefined ? {} : { stringLiteral: result.stringLiteral }),
    ...(result.readTypes === undefined ? {} : { readTypes: [...result.readTypes] }),
    regions: (engine.expressionRegions?.(row.source) ?? []).map(({ start, end }) => ({ start, end })),
  };
}

/** The row's module functions as the dispatch table evaluation reads, each
 *  recording the call it was handed before it answers as scripted. */
function dispatchTableOf(
  modules: DialectModules,
  codec: ConformanceValueCodec,
  dispatched: DialectDispatch[],
): ModuleCallDispatch {
  return new Map(
    Object.entries(modules.functions ?? {}).map(([qualified, fn]) => [
      qualified,
      (args: readonly unknown[]) => {
        dispatched.push({ name: qualified, arguments: args.map((arg) => codec.encode(arg)) });
        if (fn.error) {
          throw fn.error.code === null ? new Error(fn.error.message) : new RuntimeError(fn.error.code, fn.error.message);
        }
        if (fn.result === undefined) throw new Error(`The module function '${qualified}' scripts neither a result nor an error`);
        return codec.decode(fn.result);
      },
    ]),
  );
}

/** The runtime half: `compile` without declarations or brands, then evaluation
 *  with the bindings as the activation and the row's module functions bound as
 *  the dispatch table. */
export async function evaluateDialectRow(
  env: Environment,
  codec: ConformanceValueCodec,
  row: DialectRow,
): Promise<
  { compiled?: { refs: string[]; volatile: boolean }; dispatched?: DialectDispatch[] } & (
    | { result: unknown }
    | { error: ConformanceError }
  )
> {
  const engine = engineOf(row.tag);
  const modules = row.modules;
  const dispatched: DialectDispatch[] = [];
  const outcome = modules ? { dispatched } : {};
  let compiled: { refs?: readonly string[]; volatile?: boolean; call: (ctx: Record<string, unknown>) => unknown };
  try {
    compiled = engine.compile(row.source, {
      celEnv: withFunctions(env, row, codec),
      ...(modules ? { moduleNames: new Set(modules.names) } : {}),
    }) as typeof compiled;
  } catch (err) {
    return { ...outcome, error: conformanceError(err) };
  }
  const shape = { refs: [...(compiled.refs ?? [])].sort(), volatile: compiled.volatile === true };
  const activation: Record<string, unknown> = Object.fromEntries(
    Object.entries(row.bindings ?? {}).map(([name, value]) => [name, codec.decode(value)]),
  );
  if (modules) activation[MODULE_CALL_DISPATCH_KEY] = dispatchTableOf(modules, codec, dispatched);
  handlerRefusals.length = 0;
  let answer: { result: unknown } | { error: ConformanceError };
  try {
    answer = { result: await compiled.call(activation) };
  } catch (err) {
    answer = { error: conformanceError(err) };
  }
  // Read off the handler, not off what evaluation threw: an operator may absorb the error.
  const refusal = handlerRefusals[0];
  if (refusal) throw new MalformedRowError(`The row '${row.id}' is malformed: ${refusal.message}`, { cause: refusal });
  return { ...outcome, compiled: shape, ...answer };
}

export async function runDialectRow(
  env: Environment,
  codec: ConformanceValueCodec,
  row: DialectRow,
): Promise<DialectExpect> {
  const check = analyzeDialectRow(env, codec, row);
  const outcome = await evaluateDialectRow(env, codec, row);
  const full: DialectCheck = outcome.compiled ? { ...check, ...outcome.compiled } : check;
  const answered = { check: full, ...(outcome.dispatched ? { dispatched: outcome.dispatched } : {}) };
  if ("error" in outcome) return { ...answered, error: outcome.error };
  return { ...answered, value: codec.encode(outcome.result) };
}
