import type { AliasResolver, ModuleScopes } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ContractDirection } from "./extends-resolution.js";
import { resolveContract } from "./invocation-contract.js";
import { substituteCelFields, validateAgainstSchema } from "./schema-compat.js";
import {
  analyzerContractScope,
  containerOf,
  gatherPropertySchemas,
  missingRequired,
  resolveLocalRef,
  walkStepArray,
} from "./analyzer.js";

export interface StepInputIssue {
  path: string;
  targetLabel: string;
  message: string;
}

/**
 * Validate every step's `inputs:` against the invoked target's declared input
 * contract — the static half of what the kernel enforces at dispatch.
 *
 * Worth doing statically because a call site is where the mistake is made and
 * where the author can see both sides: a misspelled key or a wrong-shaped value
 * would otherwise surface at runtime inside the callee, several steps from its
 * cause, naming a resource the author may not have written.
 *
 * CEL leaves are replaced by schema-shaped placeholders first (`substituteCelFields`),
 * so an expression is never a false positive — only structural disagreement is
 * reported. Nothing is hardcoded about `Run.Sequence`: the invoke field comes
 * from `x-telo-step-context`, and the paired inputs field from whichever sibling
 * property carries `x-telo-topology-role: inputs`.
 */
export function collectStepInputIssues(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: ModuleScopes,
): StepInputIssue[] {
  const out: StepInputIssue[] = [];
  const props = defSchema.properties as Record<string, any> | undefined;
  if (!props) return out;

  const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = fieldSchema["x-telo-step-context"] as Record<string, string> | undefined;
    if (!stepCtx?.invoke) continue;
    const steps = manifest[fieldName];
    if (!Array.isArray(steps)) continue;

    const stepItemSchema = resolveLocalRef(
      fieldSchema.items as Record<string, any> | undefined,
      defSchema,
    );
    if (!stepItemSchema) continue;

    // The inputs field is whichever sibling declares the role — never the literal
    // name, so a composer that spells it differently still gets checked.
    let inputsField: string | undefined;
    for (const [key, sub] of gatherPropertySchemas(stepItemSchema)) {
      if (sub?.["x-telo-topology-role"] === "inputs") inputsField = key;
    }
    if (!inputsField) continue;

    walkStepArray(steps, stepItemSchema, defSchema, fieldName, (step, stepPath) => {
      const invoke = step[stepCtx.invoke] as Record<string, any> | undefined;
      const values = step[inputsField!];
      if (!invoke || typeof invoke !== "object") return;
      if (!values || typeof values !== "object" || Array.isArray(values)) return;

      const invokedKind = invoke.kind as string | undefined;
      const invokedName = invoke.name as string | undefined;
      const invokedManifest = invokedName
        ? (allManifests.find(
            (m) =>
              (m.metadata as any)?.name === invokedName && (!invokedKind || m.kind === invokedKind),
          ) as Record<string, any> | undefined)
        : (invoke as Record<string, any>);
      const invokedDef = invokedKind
        ? contractScope.resolveIn(invokedKind, readingModule)
        : undefined;
      const contract = resolveContract("inputType", invokedManifest, invokedDef, contractScope);
      if (!contract) return;

      // Findings AT a substituted path are about a placeholder, not about
      // anything the author wrote — a `pattern`-constrained string or a `oneOf`
      // of unrelated shapes cannot be satisfied by any stand-in. Structural
      // findings (missing required, unknown property) are located at the
      // container and survive the filter.
      const celPaths = new Set<string>();
      const substituted = substituteCelFields(values, contract.schema, undefined, (p) =>
        celPaths.add(p),
      );
      for (const issue of validateAgainstSchema(substituted, contract.schema)) {
        if (celPaths.has(issue.path)) continue;
        // A missing-required issue names the property that ISN'T there, so
        // anchoring on it finds no node and the diagnostic degrades to 1:1 —
        // losing the location of the most common contract mistake. Anchor on the
        // container that should have held it, which does exist.
        const anchor = missingRequired(issue) ? containerOf(issue.path) : issue.path;
        out.push({
          path: anchor ? `${stepPath}.${inputsField}.${anchor}` : `${stepPath}.${inputsField}`,
          targetLabel: invokedName ?? invokedKind ?? "the invoked resource",
          message: issue.message,
        });
      }
    });
  }
  return out;
}

