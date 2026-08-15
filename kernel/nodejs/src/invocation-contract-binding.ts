import {
  type ContractDirection,
  defaultBearingPaths,
  effectiveContractField,
  type DefResolver,
  withLiveValuesSkipped,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceInstance, ResourceManifest } from "@telorun/sdk";
import {
  ERR_CONTRACT_UNRESOLVABLE,
  ERR_INPUT_INVALID,
  ERR_OUTPUT_INVALID,
  InvokeError,
} from "@telorun/sdk";

/**
 * Binds a resource's resolved invocation contract to its dispatch entry points,
 * at the moment the kernel produces the instance.
 *
 * A contract is only a guarantee if it cannot be dispatched around, and most
 * consumers never reach the kernel's dispatch chokepoint: Phase-5 injection puts
 * the live instance straight into a consumer's config object, so `Ai.Agent`
 * reads `this.resource.model` and calls `model.invoke(...)` in hand. Enforcing at
 * a handoff would mean enforcing at every handoff — Phase-5 injection,
 * `ctx.resolveRef`, scope-handle resolution, the template controller's direct
 * dispatch, `ctx.invoke`'s target lookup — and one forgotten site silently
 * reopens the hole.
 *
 * So the kernel binds instead, at `_createInstance`: its single production site.
 * Every consumer, on every path, then holds an instance whose dispatch already
 * enforces. Binding rather than wrapping is also what keeps the rest a
 * non-problem — there is one object, so controller-specific members are
 * genuinely its own, the prototype chain (and `instanceof` across the SDK realm
 * boundary) is untouched, and `stripCompiledValues` / `detachSnapshotValue` see
 * exactly the object they always saw. It is the same in-place technique the
 * kernel already uses to fold detached-task draining into `teardown()` and
 * runtime CEL expansion into `invoke()`.
 *
 * Consequence, stated rather than left to be discovered: the bound `invoke`
 * shadows the controller's, so a controller calling `this.invoke()` internally
 * goes through its own contract.
 */

/** Compiles a JSON Schema to a validator. The kernel's `SchemaValidator` runs
 *  with `useDefaults`, so validating also fills declared defaults. */
export interface ContractValidatorFactory {
  (typeRef: unknown): { validate(value: unknown): void };
  /** Resolves a type field to its JSON Schema, for the schema-level decisions
   *  (stream skipping, default paths) a compiled validator can't answer. */
  schemaOf(typeRef: unknown): Record<string, any> | undefined;
  /** Resolves a `$ref` to the registered schema it names, so the schema walks
   *  can see through the reference form the compiled validator keeps intact. */
  resolveRef(ref: string): Record<string, any> | undefined;
  /** Compiles an adjusted schema while keeping the CEL `rules:` registered under
   *  a named type — the one path that survives stripping a stream property from
   *  a named contract without abandoning its invariants. */
  withRules(name: string | undefined, schema: Record<string, any>): { validate(value: unknown): void };
}

export interface BoundContract {
  direction: ContractDirection;
  validate(value: unknown): void;
  /** Paths a default can be written to — how far the caller's value must be
   *  copied before validation runs. Empty when the contract declares none. */
  defaultPaths(): string[][];
}

const CONTRACT_ERROR: Record<ContractDirection, string> = {
  inputType: ERR_INPUT_INVALID,
  outputType: ERR_OUTPUT_INVALID,
};

/**
 * Resolve one direction of a resource's contract to a bound validator.
 *
 * The declaration is layered instance-manifest → nearest along `extends` (see
 * `effectiveContractField` — nearest wins, contracts never merge), then compiled.
 *
 * A NAMED reference (`inputType: RequestShape`, or a `!ref` to a type) is
 * compiled by name so it keeps the CEL `rules:` registered alongside it, which a
 * plain schema copy would drop. Everything else is compiled from the resolved
 * schema — inline `{kind, schema}` and raw forms carry no rules, and resolving
 * first is what lets a `{ $ref: "telo://Self/X" }` contract compile at all
 * (`resolveTypeSchema` follows it through the kernel's registry, which AJV
 * cannot).
 *
 * The resolved schema is stripped of `x-telo-stream` properties first: a live
 * `Stream` in a declared slot is not data to be traversed, the same defect as
 * `stripCompiledValues` walking a live instance in a ref slot. Streams travel in
 * both directions (`Codec.Encoder` marks `input` on its `inputType` and requires
 * it), so the skip is not one-directional.
 *
 * WHICH declaration applies is decided here, at create time — that is a fact
 * about the manifest. COMPILING it is deferred to first dispatch and memoized: a
 * contract may reference a named `telo#Type` whose `Type.JsonSchema` resource
 * initializes later in the same multi-pass loop, and resolving it eagerly would
 * make every contract-declaring kind depend on type-registration order. Nothing
 * can dispatch before the loop finishes, so first-use is always late enough.
 */
/** True when a type field names a registered `telo#Type` — a bare name, or the
 *  `{kind, name}` object a `!ref` normalizes to. Only these carry CEL `rules:`,
 *  so only these are worth compiling by name rather than from their schema. */
function isNamedTypeReference(declared: unknown): boolean {
  if (typeof declared === "string") return true;
  if (!declared || typeof declared !== "object") return false;
  const ref = declared as Record<string, unknown>;
  return typeof ref.name === "string" && !(ref.schema && typeof ref.schema === "object");
}

export function resolveBoundContract(
  direction: ContractDirection,
  manifest: ResourceManifest,
  definition: ResourceDefinition | undefined,
  resolveDef: DefResolver,
  factory: ContractValidatorFactory,
): BoundContract | undefined {
  const own = (manifest as unknown as Record<string, unknown>)[direction];
  const declared =
    own !== undefined && own !== null
      ? own
      : effectiveContractField(definition, resolveDef, direction);
  if (declared === undefined || declared === null) return undefined;

  let compiled: { validate(value: unknown): void } | undefined;
  let paths: string[][] | undefined;

  const resolve = (): { validate(value: unknown): void } => {
    if (compiled !== undefined) return compiled;
    const schema = factory.schemaOf(declared);
    if (!schema) {
      // A declared contract that resolves to nothing is a manifest fault — a
      // named type that never registered — and it MUST NOT degrade to
      // "unvalidated". Silently disabling enforcement is the failure mode
      // nobody notices: every later call passes because nothing is checking.
      throw new InvokeError(
        ERR_CONTRACT_UNRESOLVABLE,
        `declared \`${direction}\` could not be resolved to a schema: ${describeDeclaration(declared)}. ` +
          `The type is not registered, so the contract cannot be enforced.`,
      );
    }
    const stripped = withLiveValuesSkipped(schema, factory.resolveRef);
    paths = defaultBearingPaths(stripped, factory.resolveRef);
    // Compile by NAME whenever the declaration is one, so the type's CEL
    // `rules:` are composed in — including when a stream had to be stripped, in
    // which case the stream-bearing properties are dropped from the schema the
    // named validator sees rather than the reference being abandoned.
    compiled = !isNamedTypeReference(declared)
      ? factory(stripped)
      : stripped === schema
        ? factory(declared)
        : factory.withRules(nameOf(declared), stripped);
    return compiled;
  };

  return {
    direction,
    validate: (value: unknown) => resolve().validate(value),
    defaultPaths: () => {
      resolve();
      return paths ?? [];
    },
  };
}

const nameOf = (declared: unknown): string | undefined =>
  typeof declared === "string"
    ? declared
    : ((declared as Record<string, unknown> | null)?.name as string | undefined);

const describeDeclaration = (declared: unknown): string =>
  typeof declared === "string" ? `'${declared}'` : JSON.stringify(declared);

/**
 * A copy of `value` deep along exactly the paths a default can be written to and
 * shared everywhere else.
 *
 * A flat shallow copy would not do: AJV's `useDefaults` writes at every level it
 * finds a default, so a nested default would mutate the structure the caller
 * still holds. Bounded by the schema's defaults rather than by the size of the
 * payload — a contract declaring no defaults copies one level and nothing more.
 */
export function copyForDefaults(value: unknown, paths: readonly string[][]): unknown {
  if (!value || typeof value !== "object") return value;
  let out = shallowCopy(value);
  for (const path of paths) {
    // The leaf is what gets written; every CONTAINER above it is what must not
    // be shared. An `[]` segment fans out: the default lands in each element, so
    // the array and every element on the path have to be copied too — bailing
    // there would leave `rows[0]` shared and let a fill mutate the caller's data.
    out = copyAlong(out, path.slice(0, -1));
  }
  return out;
}

const shallowCopy = (value: object): any =>
  Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };

function copyAlong(node: unknown, segments: readonly string[]): unknown {
  if (!node || typeof node !== "object") return node;
  if (segments.length === 0) return node;
  const [head, ...rest] = segments;

  if (head === "[]") {
    if (!Array.isArray(node)) return node;
    return node.map((item) =>
      item && typeof item === "object" ? copyAlong(shallowCopy(item), rest) : item,
    );
  }

  const container = node as Record<string, unknown>;
  const child = container[head!];
  if (!child || typeof child !== "object") return node;
  container[head!] = copyAlong(shallowCopy(child), rest);
  return node;
}

/**
 * Raise a contract violation as a structured {@link InvokeError}.
 *
 * Structured rather than a plain error because the run engine assigns
 * `INTERNAL_ERROR` to anything that is not an `InvokeError` — a contract
 * violation would then reach a `catch` block indistinguishable from a crash, and
 * an author could neither match it nor rethrow it faithfully. These are ambient
 * kernel codes: catchable by name, and never counted against a kind's own
 * `throws:` union.
 *
 * The message names the target, the direction, and the offending detail, because
 * a caller several steps away otherwise cannot tell which boundary rejected the
 * value or which side supplied it.
 */
export function contractViolation(
  direction: ContractDirection,
  describeTarget: () => string,
  cause: unknown,
): Error {
  // A type's CEL `rules:` raise the author's OWN code — that is the whole point
  // of declaring one, and `modules/type` documents rule codes as catchable.
  // Only a structural schema failure is the ambient contract violation.
  //
  // Re-raised as a STRUCTURED error carrying that code: the rule itself throws a
  // `RuntimeError`, which has a code but not the marker a catch block matches
  // on, so it used to reach `catch` as the generic plain-failure code — the
  // documented behaviour never actually worked. Wrapping preserves the code and
  // makes it match.
  const ruleCode = ruleViolationCode(cause);
  if (ruleCode) {
    return new InvokeError(ruleCode, (cause as Error).message, undefined, { cause });
  }

  const side = direction === "inputType" ? "inputs" : "result";
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new InvokeError(
    CONTRACT_ERROR[direction],
    `${describeTarget()}: ${side} do not satisfy the declared ${direction}: ${detail}`,
    undefined,
    { cause },
  );
}

/** Codes the validator itself raises for a STRUCTURAL failure. Anything else
 *  carrying a code came from a declared rule and belongs to its author. */
const STRUCTURAL_VALIDATION_CODES = new Set([
  "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
  "ERR_TYPE_NOT_FOUND",
]);

function ruleViolationCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || code.length === 0) return undefined;
  return STRUCTURAL_VALIDATION_CODES.has(code) ? undefined : code;
}

export interface ContractBinding {
  input?: BoundContract;
  output?: BoundContract;
  /** Names the resource in a violation message — the target, so a caller several
   *  steps away can tell which boundary rejected the value. */
  describeTarget(): string;
}

/**
 * Bind `invoke()` and `provide()` in place.
 *
 * `provide()` takes no caller arguments, so it has no input side, but it returns
 * a value against a declared `outputType` and that result is validated exactly as
 * an invocable's is — same path, same stream skip, same ambient error code.
 * `run()` is bound to nothing: parameterless and void, there is nothing to fill
 * defaults into and no result to validate, so it is guarded statically instead.
 */
export function bindContract(instance: ResourceInstance, binding: ContractBinding): void {
  const { input, output, describeTarget } = binding;
  if (!input && !output) return;

  if (typeof instance.invoke === "function") {
    const original = instance.invoke.bind(instance) as (
      inputs: any,
      ...rest: unknown[]
    ) => Promise<unknown>;
    // EVERY argument is forwarded, not just `inputs`. `invoke(inputs, ctx)`
    // carries the InvokeContext — cancellation, tracing — as its second
    // parameter, and a wrapper that takes only `inputs` silently drops it: a
    // detached body would then never see its cancellation token and a lease
    // holding across it would never be released. The contract only concerns the
    // first argument; the rest belong to the caller and the callee.
    instance.invoke = async (inputs: any, ...rest: unknown[]) => {
      let effective = inputs;
      if (input) {
        // Copied only so the validator's default-fill cannot mutate what the
        // caller still holds. The BigInt normalization a JSON Schema validator
        // needs (CEL evaluates an integer to one, which AJV does not recognise
        // as `integer`) belongs to the validator and is applied there — see
        // `bigint-schema-view.ts`. Doing it here as well would walk every input
        // tree twice per dispatch, and split one concern across two layers.
        effective = copyForDefaults(inputs, input.defaultPaths());
        try {
          input.validate(effective);
        } catch (error) {
          throw contractViolation("inputType", describeTarget, error);
        }
      }
      const result = await original(effective, ...rest);
      if (output) {
        try {
          output.validate(result);
        } catch (error) {
          throw contractViolation("outputType", describeTarget, error);
        }
      }
      return result;
    };
  }

  if (output && typeof instance.provide === "function") {
    const original = instance.provide.bind(instance) as (...args: unknown[]) => Promise<unknown>;
    instance.provide = async (...args: unknown[]) => {
      const result = await original(...args);
      try {
        output.validate(result);
      } catch (error) {
        throw contractViolation("outputType", describeTarget, error);
      }
      return result;
    };
  }
}

