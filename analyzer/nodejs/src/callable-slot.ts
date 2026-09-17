/**
 * **A function in a slot constrained to a callable abstract** — satisfied by
 * `extends`, or by STRUCTURE.
 *
 * A `Telo.Function` cannot extend anything, and a native callable written for one
 * library's abstract is usually exactly the function another library's slot asks
 * for, so a function whose signature can stand in for the abstract's satisfies
 * the slot without naming it (`signature-substitution.ts`, the comparison a kind
 * replacing an abstract's signature is held to). A mismatch names the parameter
 * or the result that fails. Determinism is the third dimension: an abstract
 * requiring `deterministic: true` refuses a function whose derived flag is false,
 * naming the chain to the leaf that made it so.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { renderChain, type CallableFlagsIndex } from "./callable-flags.js";
import {
  isCallableKind,
  readParams,
  readReturns,
  requiresDeterminism,
  signatureDeclarer,
} from "./callable-signature.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { DefResolver } from "./extends-resolution.js";
import type { ModuleFunctionIndex } from "./module-function-index.js";
import { signatureMismatches } from "./signature-substitution.js";
import { describeSignatureMismatch } from "./validate-invocation-contract.js";

export interface CallableSlotContext {
  /** The analyzed manifests — where a kind's twin with its `!ref`s resolved is. */
  readonly resources: readonly ResourceManifest[];
  readonly registry: DefinitionRegistry;
  readonly resolveDef: DefResolver;
  readonly functions: ModuleFunctionIndex;
  readonly flags: CallableFlagsIndex;
}

export type CallableSlotVerdict =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly reasons: readonly string[] };

/**
 * Whether `referent`, written `label` at the slot, satisfies a slot constrained
 * to `targetKinds` by structure — or undefined when the question does not arise:
 * no constraint is a callable abstract, or the referent is not a function. The
 * nominal verdict stands then.
 */
export function callableSlotVerdict(
  referent: ResourceManifest,
  label: string,
  targetKinds: readonly string[],
  ctx: CallableSlotContext,
): CallableSlotVerdict | undefined {
  const targets = targetKinds
    .map((kind) => ctx.registry.resolve(ctx.registry.resolveRef(kind) ?? kind))
    .filter(
      (def): def is ResourceDefinition =>
        !!def && def.kind === "Telo.Abstract" && isCallableKind(def, ctx.resolveDef),
    );
  if (targets.length === 0 || !ctx.functions.isFunction(referent)) return undefined;

  const own = ctx.functions.signatureOf(referent) as unknown as Record<string, unknown>;
  const resolveRef = (ref: string) => ctx.registry.schemaForId(ref);
  const reasons: string[] = [];
  for (const target of targets) {
    const targetName = `${target.metadata?.module}.${target.metadata?.name}`;
    const required = {
      params: readParams(analyzedTwin(ctx, signatureDeclarer(target, ctx.resolveDef, "params"))),
      returns: readReturns(
        analyzedTwin(ctx, signatureDeclarer(target, ctx.resolveDef, "returns")),
      ),
    };
    const failures = signatureMismatches(
      own,
      required,
      { params: true, returns: true },
      resolveRef,
    ).map((mismatch) => describeSignatureMismatch(mismatch, targetName).text);
    if (requiresDeterminism(target, ctx.resolveDef)) {
      const flags = ctx.flags.ofResource(referent, label);
      if (!flags.deterministic) {
        failures.push(
          `'${targetName}' requires a deterministic function, and '${label}' is not ` +
            `(${renderChain(flags.nondeterministicVia)}).`,
        );
      }
    }
    if (failures.length === 0) return { satisfied: true };
    reasons.push(
      `'${label}' does not extend '${targetName}', and cannot stand in for it: ` +
        failures.join(" "),
    );
  }
  return { satisfied: false, reasons };
}

/** The analyzed manifest declaring the same kind as `def`, whose signature
 *  `!ref`s are resolved — the registry's copy was registered before resolution. */
function analyzedTwin(
  ctx: CallableSlotContext,
  def: ResourceDefinition | undefined,
): Record<string, unknown> | undefined {
  if (!def) return undefined;
  const module = (def.metadata as { module?: string } | undefined)?.module;
  const twin = ctx.resources.find(
    (m) =>
      m.kind === def.kind &&
      m.metadata?.name === def.metadata?.name &&
      (m.metadata as { module?: string } | undefined)?.module === module,
  );
  return (twin ?? def) as unknown as Record<string, unknown>;
}
