/**
 * `REFERENCE_OUTPUT_MISMATCH` — a reference slot declaring `x-telo-ref`
 * `outputType:` names a target whose output contract cannot be that shape.
 *
 * A kind constraint says what a target IS, never what it RETURNS: a slot that
 * accepts `Telo.Executable` admits every sequence, and whether one returns the
 * shape the holder reads off it (`Stream.Concat` pulls `output` from each
 * source) was known only when the holder dispatched it. The target's output
 * contract is resolved exactly as `steps.<name>.result` is typed — the target's
 * own `outputType`, then its kind's along `extends`, then the key set of a
 * value-derived `outputs:` map — and compared with the covariant comparator,
 * so only a DEFINITE mismatch reports and a target declaring no contract gives
 * no verdict (the holder's own runtime refusal stays the backstop there).
 *
 * Runs over the analyzed manifests after inline extraction, so an inline target
 * is checked like a named one; a generated name never reaches a message.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition } from "@telorun/sdk";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { AliasResolver } from "./alias-resolver.js";
import {
  analyzerContractScope,
  resolveContract,
  type ContractScope,
} from "./invocation-contract.js";
import {
  isRefEntry,
  refSlotOfEntry,
  resolveFieldEntries,
  type ReferenceFieldMap,
} from "./reference-field-map.js";
import type { RefSlot } from "./ref-slot.js";
import { checkSchemaCompatibility } from "./schema-compat.js";
import { valueDerivedContract } from "./value-derived-contract.js";
import { callSiteContext, type CallScopes } from "./validate-step-inputs.js";

/**
 * What a target returns, resolved exactly as `steps.<name>.result` is typed:
 * the instance's own `outputType`, then its kind's along `extends`, then the
 * key set of a value-derived `outputs:` map. Undefined when none declares one —
 * an absence of a claim, which no check may read as a mismatch.
 */
export function producedOutputContract(
  target: Record<string, any> | undefined,
  definition: ResourceDefinition | undefined,
  scope: ContractScope,
  defs: DefinitionRegistry,
): Record<string, any> | undefined {
  return (
    resolveContract("outputType", target, definition, scope)?.schema ??
    valueDerivedContract(
      target,
      defs.effectiveSchemaOf(definition) as Record<string, any> | undefined,
      "outputType",
    )
  );
}

/** Each mismatch is told from the slot's side: what the target's output lacks
 *  or holds against what this slot reads. */
const OUTPUT_ROLES = { source: "the target's output", target: "this slot" };

/**
 * Why a target producing `produced` cannot fill `slot`: one line per definite
 * mismatch against the slot's `outputType`, empty when it can — or when the
 * slot asks nothing of the result, or the target declares no output. The one
 * verdict `telo check` and every editor affordance share.
 */
export function referenceOutputRefusal(
  slot: RefSlot,
  produced: Record<string, any> | undefined,
  defs: DefinitionRegistry,
): string[] {
  if (!slot.outputType || !produced) return [];
  const { compatible, issues } = checkSchemaCompatibility(
    produced,
    slot.outputType,
    (id) => defs.schemaForId(id),
    OUTPUT_ROLES,
  );
  return compatible ? [] : issues;
}

export interface ReferenceOutputIssue {
  /** Concrete path of the reference slot. */
  path: string;
  message: string;
}

/** How a target is named in a message: its declared name, or its kind alone
 *  when inline extraction generated the name. */
function targetLabel(target: Record<string, any>): string {
  const metadata = target.metadata as { name?: string; xTeloOrigin?: unknown } | undefined;
  if (metadata?.xTeloOrigin !== undefined || typeof metadata?.name !== "string") {
    return `the inline ${String(target.kind)}`;
  }
  return `${String(target.kind)} '${metadata.name}'`;
}

export function collectReferenceOutputIssues(
  manifest: Record<string, any>,
  fieldMap: ReferenceFieldMap | undefined,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: CallScopes,
): ReferenceOutputIssue[] {
  const out: ReferenceOutputIssue[] = [];
  if (!fieldMap) return out;
  const ctx = callSiteContext(manifest, allManifests, defs, aliases, scopes);
  const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;

  for (const [fieldPath, entry] of fieldMap) {
    if (!isRefEntry(entry) || !entry.outputType) continue;
    const slot = refSlotOfEntry(entry);
    for (const { value: ref, path } of resolveFieldEntries(manifest, fieldPath)) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const reference = ref as Record<string, any>;
      if (typeof reference.kind !== "string") continue;
      const target = typeof reference.name === "string" ? ctx.resolveTarget(reference) : reference;
      if (!target) continue;
      const definition = contractScope.resolveIn(reference.kind, readingModule);
      const issues = referenceOutputRefusal(
        slot,
        producedOutputContract(target, definition, contractScope, defs),
        defs,
      );
      if (issues.length === 0) continue;
      out.push({
        path,
        message:
          `${targetLabel(target)} does not return what this slot reads from it. The slot requires ` +
          `an output of ${JSON.stringify(slot.outputType)}; its declared output contract disagrees: ` +
          `${issues.join("; ")}.`,
      });
    }
  }
  return out;
}
