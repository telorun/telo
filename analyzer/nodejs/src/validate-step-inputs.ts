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
import { isLiveSlot, valueTypeOf, type ResourceDefinition } from "@telorun/sdk";
import { manifestFragmentOf } from "./manifest-schemas.js";
import {
  analyzerContractScope,
  containerOf,
  gatherPropertySchemas,
  missingRequired,
  resolveLocalRef,
  walkStepArray,
} from "./analyzer.js";
import { readStepSlot } from "./step-slot.js";
import { navigateConcretePath } from "./manifest-path.js";
import {
  isRefEntry,
  resolveFieldEntries,
  type ReferenceFieldMap,
} from "./reference-field-map.js";

export interface StepInputIssue {
  path: string;
  targetLabel: string;
  message: string;
  /** Set when the issue is a type-argument disagreement rather than a contract
   *  shape violation — the two read differently and deserve their own code. */
  code?: "CEL_TYPE_ARGUMENT_MISMATCH" | "LIVE_VALUE_RETRIED";
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
 * from the step slot (the shared grammar, or the legacy `x-telo-step-context`),
 * and the paired inputs field from whichever sibling
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

  const ctx: CallCheckContext = {
    manifest,
    allManifests,
    defs,
    contractScope,
    readingModule,
    stepContext,
  };

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = readStepSlot(fieldSchema);
    if (!stepCtx) continue;
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

      out.push(
        ...checkCallSite(
          {
            inputsPath: `${stepPath}.${inputsField}`,
            values: values as Record<string, any>,
            invoke,
            // Only a step declares a re-attempt policy, so only a step can carry
            // the live-value-retried finding.
            declaredRetryFor: (invokedManifest, invokedDef) =>
              declaredRetry(step, stepItemSchema, invokedManifest, invokedDef),
          },
          ctx,
        ),
      );
    });
  }
  return out;
}

/**
 * Validate the argument map of every call this resource makes through a
 * REFERENCE SLOT, as opposed to a step.
 *
 * A slot that transfers control names its argument slot on its own `x-telo-ref`
 * (`inputs:`, a JSON Pointer relative to the object enclosing the slot). That
 * annotation is the only thing tying an otherwise-open `inputs:` map to the
 * resource it holds arguments for — an HTTP route's `handler:` + `inputs:` pair
 * is exactly this shape, and nothing about it is a step.
 *
 * Discovery is driven by the annotation rather than by any kind's topology, so
 * a composer that names its argument slot gets its call sites checked without
 * the analyzer learning what a route is. It is the same check the step driver
 * runs, because it is the same question.
 */
export function collectRefInputIssues(
  manifest: Record<string, any>,
  fieldMap: ReferenceFieldMap | undefined,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: ModuleScopes,
): StepInputIssue[] {
  const out: StepInputIssue[] = [];
  if (!fieldMap) return out;

  const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests);
  const ctx: CallCheckContext = {
    manifest,
    allManifests,
    defs,
    contractScope,
    readingModule: (manifest.metadata as { module?: string } | undefined)?.module,
  };

  for (const [fieldPath, entry] of fieldMap) {
    if (!isRefEntry(entry) || !entry.inputs) continue;
    const pointer = pointerSegments(entry.inputs);
    if (!pointer) continue;

    for (const { value: invoke, path: slotPath } of resolveFieldEntries(manifest, fieldPath)) {
      if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) continue;
      // Relative to the object ENCLOSING the slot, which is the annotation's
      // documented anchor.
      const enclosing = slotPath.slice(0, Math.max(0, slotPath.lastIndexOf(".")));
      const inputsPath = [enclosing, ...pointer].filter(Boolean).join(".");
      const values = navigateConcretePath(manifest, inputsPath);
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;

      out.push(
        ...checkCallSite(
          { inputsPath, values: values as Record<string, any>, invoke: invoke as Record<string, any> },
          ctx,
        ),
      );
    }
  }
  return out;
}

/** A JSON Pointer naming a sibling FIELD path. An array index is not a field,
 *  so a pointer carrying one names nothing this can resolve. */
function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.every((s) => s.length > 0 && !/^\d+$/.test(s)) ? segments : undefined;
}

/** One call site: the arguments written, and the reference they are for. */
interface CallSite {
  /** Concrete path of the argument map, for anchoring a diagnostic. */
  inputsPath: string;
  values: Record<string, any>;
  invoke: Record<string, any>;
  declaredRetryFor?(
    invokedManifest: Record<string, any> | undefined,
    invokedDef: ResourceDefinition | undefined,
  ): string | undefined;
}

interface CallCheckContext {
  manifest: Record<string, any>;
  allManifests: Record<string, any>[];
  defs: DefinitionRegistry;
  contractScope: ReturnType<typeof analyzerContractScope>;
  readingModule: string | undefined;
  stepContext?: Record<string, any>;
}

/**
 * The check itself, shared by both drivers: the arguments written at a call site
 * against the contract the target declares.
 */
function checkCallSite(site: CallSite, ctx: CallCheckContext): StepInputIssue[] {
  const out: StepInputIssue[] = [];
  const { manifest, allManifests, defs, contractScope, readingModule, stepContext } = ctx;
  const { invoke, values } = site;
  {
    {
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
      if (!contract) return out;

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
      // The roots a plain chain may name here, each paired with the schema it is
      // navigated against. `steps.` is the step map (analyzer state, supplied by
      // the caller). `inputs.` is the ENCLOSING kind's own declared inputType,
      // which is how a value produced OUTSIDE this resource reaches a step at
      // all: an HTTP route maps `request.body` into its handler's inputs, and the
      // handler forwards `inputs.body` onward — the shape a live value most often
      // arrives in, and the one covering only `steps.` missed entirely. A root
      // this cannot resolve contributes nothing rather than guessing at a schema.
      const roots: Array<[string, Record<string, any>]> = [];
      if (stepContext) roots.push(["steps.", stepContext]);
      const ownContract = resolveContract(
        "inputType",
        manifest,
        contractScope.resolveIn(manifest.kind as string, readingModule),
        contractScope,
      );
      if (ownContract) roots.push(["inputs.", ownContract.schema]);

      if (roots.length > 0) {
        for (const [inputName, inputValue] of Object.entries(values)) {
          const chain = plainChainOf(inputValue);
          const root = chain ? roots.find(([prefix]) => chain.startsWith(prefix)) : undefined;
          if (!chain || !root) continue;
          const produced = navigateSchemaToExprPath(root[1], chain.slice(root[0].length));
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
          // A LIVE value is consumed by reading, so it exists exactly once —
          // that is what `live` says in the vocabulary, and re-attempting a
          // dispatch that already read it re-sends nothing. Reported here rather
          // than through a slot-specific annotation because both facts are
          // already declared: the value's liveness by its value type, and the
          // re-attempt by the retry policy. No kind is named.
          if (isLiveSlot(produced)) {
            const retry = site.declaredRetryFor?.(invokedManifest, invokedDef);
            if (retry !== undefined) {
              out.push({
                path: `${site.inputsPath}.${inputName}`,
                targetLabel: invokedName ?? invokedKind ?? "the invoked resource",
                message:
                  `'${inputName}' is a live value, which is consumed by reading and so exists ` +
                  `once — but ${retry} re-attempts the dispatch, and a re-attempt would pass ` +
                  `nothing. Collect it to a value first, or chunk the work so each attempt ` +
                  `carries its own replayable piece.`,
                code: "LIVE_VALUE_RETRIED",
              });
              continue;
            }
          }
          if (!valueTypeOf(produced) || !valueTypeOf(slotSchema)) continue;
          const { compatible, issues } = checkSchemaCompatibility(produced, slotSchema, (ref) =>
            defs.schemaForId(ref),
          );
          if (compatible) continue;
          out.push({
            path: `${site.inputsPath}.${inputName}`,
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
          path: anchor ? `${site.inputsPath}.${anchor}` : site.inputsPath,
          targetLabel: invokedName ?? invokedKind ?? "the invoked resource",
          message: issue.message,
        });
      }
    }
  }
  return out;
}

/**
 * Where a re-attempt is declared for this dispatch, described for a diagnostic,
 * or undefined when none is.
 *
 * A field declares one when its schema was expanded from a shared retry fragment
 * — the shape the author pointed at, rather than a marker they had to remember to
 * write beside it. Which fragment also says WHERE the budget is, so the two
 * spellings a kind may carry (a policy object, or the deprecated bare count) need
 * no guessing between them and no rule about which one wins.
 *
 * Two sites are consulted because there are two real ones: the STEP's own policy
 * — `retry` on the kernel-owned dispatch site — and the TARGET's, a field on an
 * arbitrary kind, because `Http.Request` re-attempts inside its own `invoke()`
 * where only it can tell a 429 from a 500. A live value is equally doomed by
 * either. EVERY retry-bearing field at a site is checked, not the first, since
 * `Http.Request` carries both spellings and property order must not decide which
 * is seen.
 *
 * Only a STATICALLY KNOWN non-zero budget counts. An `attempts` written as CEL
 * says nothing here, and guessing would report a conflict against a manifest that
 * may never retry — the same posture the `use` case-map selector takes.
 */
function declaredRetry(
  step: Record<string, any>,
  stepItemSchema: Record<string, any> | undefined,
  invokedManifest: Record<string, any> | undefined,
  invokedDef: Record<string, any> | undefined,
): string | undefined {
  for (const [field, budget] of retryFields(stepItemSchema)) {
    if (budget(step?.[field]) > 0) return `the step's \`${field}\``;
  }
  for (const [field, budget] of retryFields(invokedDef?.schema as Record<string, any>)) {
    if (budget(invokedManifest?.[field]) > 0) return `the target's \`${field}\``;
  }
  return undefined;
}

/** How each shared retry fragment carries its budget. Keyed on fragment name —
 *  the analyzer's own built-ins, never a module's kind — so a kind that adopts a
 *  shape is covered without naming it here. */
const RETRY_BUDGET: Record<string, (value: unknown) => number> = {
  RetryPolicy: (value) => {
    if (!value || typeof value !== "object") return 0;
    const attempts = (value as Record<string, unknown>).attempts;
    return typeof attempts === "number" ? attempts : 0;
  },
  RetryAttempts: (value) => (typeof value === "number" ? value : 0),
};

/** Every property of `schema` whose shape came from a retry fragment, paired with
 *  the reader for that fragment's budget. */
function retryFields(
  schema: Record<string, any> | undefined,
): Array<[string, (value: unknown) => number]> {
  if (!schema) return [];
  const out: Array<[string, (value: unknown) => number]> = [];
  for (const [key, sub] of gatherPropertySchemas(schema)) {
    const budget = RETRY_BUDGET[manifestFragmentOf(sub) ?? ""];
    if (budget) out.push([key, budget]);
  }
  return out;
}
