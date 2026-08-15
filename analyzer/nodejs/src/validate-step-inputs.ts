import type { AliasResolver, ModuleScopes } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ContractDirection } from "./extends-resolution.js";
import { resolveContract } from "./invocation-contract.js";
import {
  checkSchemaCompatibility,
  navigateSchemaToExprPath,
  substituteCelFields,
  validateAgainstSchema,
} from "./schema-compat.js";
import { plainChainOf } from "@telorun/templating";
import { valueTypeOf } from "@telorun/sdk";
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
  /** Set when the issue is a type-argument disagreement rather than a contract
   *  shape violation — the two read differently and deserve their own code. */
  code?: "CEL_TYPE_ARGUMENT_MISMATCH";
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
  /** The typed `steps.<name>.result` context for this resource. Supplied by the
   *  caller because building it is analyzer state; without it the contract check
   *  still runs and only the type-argument comparison is skipped. */
  stepContext?: Record<string, any>,
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
      // The type-argument check, at the one site where a produced value's schema
      // meets a consuming slot's. A CEL leaf's placeholder says nothing about
      // what the expression yields, so AJV above is silent here by design — and
      // that silence is exactly where a stream of the wrong element used to
      // flow. The comparison is covariant and gradual: an omitted argument is
      // *any* in both directions, so only a definite conflict is reported.
      if (stepContext) {
        for (const [inputName, inputValue] of Object.entries(values)) {
          const chain = plainChainOf(inputValue);
          // The step context is rooted at the STEP MAP, so a `steps.` prefix is
          // the namespace name and not a property of it. Only that namespace is
          // navigated: `inputs.` and a named binding resolve elsewhere, and
          // guessing at a root this does not hold would compare the wrong schema.
          if (!chain?.startsWith("steps.")) continue;
          const produced = navigateSchemaToExprPath(stepContext, chain.slice("steps.".length));
          const slotSchema = (contract.schema.properties as Record<string, any> | undefined)?.[
            inputName
          ];
          if (!produced || !slotSchema) continue;
          // ONLY a type-argument disagreement, which is what the code says. The
          // comparator is a general structural comparison, so running it on any
          // pair would report a missing required property as "disagreeing type
          // arguments" — and would turn every plain-chain wiring site into a
          // broad new Error-severity check hidden behind an argument-specific
          // name. Both sides must declare a value type for the question to be
          // about arguments at all.
          if (!valueTypeOf(produced) || !valueTypeOf(slotSchema)) continue;
          const { compatible, issues } = checkSchemaCompatibility(produced, slotSchema, (ref) =>
            defs.schemaForId(ref),
          );
          if (compatible) continue;
          out.push({
            path: `${stepPath}.${inputsField}.${inputName}`,
            targetLabel: invokedName ?? invokedKind ?? "the invoked resource",
            message: issues.join("; "),
            code: "CEL_TYPE_ARGUMENT_MISMATCH",
          });
        }
      }

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

