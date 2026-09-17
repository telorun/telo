import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver, ModuleScopes } from "./alias-resolver.js";
import { resolveReferenceTarget } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { analyzerContractScope, resolveContract } from "./invocation-contract.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { gatherPropertySchemas } from "./schema-walk.js";
import { checkSchemaCompatibility, navigateSchemaToExprPath } from "./schema-compat.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import { plainChainOf } from "@telorun/templating";
import { isLiveSlot, valueTypeOf } from "@telorun/sdk";
import { manifestFragmentOf } from "./manifest-schemas.js";
import {
  slotCallSites,
  stepCallSites,
  type CallSite,
  type DerivedSlotContext,
} from "./derived-slots.js";
import type { ReferenceFieldMap } from "./reference-field-map.js";

export interface StepInputIssue {
  path: string;
  targetLabel: string;
  message: string;
  /** Set when the issue is a type-argument disagreement rather than a contract
   *  shape violation — the two read differently and deserve their own code. */
  code?: "CEL_TYPE_ARGUMENT_MISMATCH" | "LIVE_VALUE_RETRIED";
}

/** The per-declaring-module alias tables and the entry's own modules. */
type CallScopes = ModuleScopes & { aliasesByModule: Map<string, AliasResolver> };

/** True when an issue reports a property that is absent — its path points at a
 *  node the manifest does not contain. */
const missingRequired = (issue: { message: string }): boolean =>
  /is missing required property/.test(issue.message);

/** The path minus its last segment: the node that should have contained the
 *  missing property. Empty for a top-level miss, which anchors on the map. */
function containerOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

const declarationsByName = new WeakMap<object, Map<string, ResourceManifest[]>>();

/** The analyzed set's declarations by name, built once per set. */
function byNameOf(allManifests: Record<string, any>[]): Map<string, ResourceManifest[]> {
  let byName = declarationsByName.get(allManifests);
  if (!byName) {
    byName = new Map();
    for (const m of allManifests as ResourceManifest[]) {
      const name = m.metadata?.name;
      if (typeof name !== "string" || m.kind === "Telo.Import") continue;
      const list = byName.get(name);
      if (list) list.push(m);
      else byName.set(name, [m]);
    }
    declarationsByName.set(allManifests, byName);
  }
  return byName;
}

/** The reader's context for these checks: a call target resolves in the scope of
 *  the module `manifest` belongs to — a bare name same module first, an alias
 *  through that module's import — as the kernel resolves it at dispatch. */
function callSiteContext(
  manifest: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: CallScopes,
): DerivedSlotContext {
  const fromModule = (manifest.metadata as { module?: string } | undefined)?.module;
  const scope = moduleAliasScope({ module: fromModule }, aliases, scopes.aliasesByModule);
  return {
    defs,
    aliases,
    aliasesByModule: scopes.aliasesByModule,
    rootModules: scopes.rootModules,
    typeManifests: allManifests,
    resolveTarget: (ref) =>
      typeof ref.name === "string"
        ? (resolveReferenceTarget(
            byNameOf(allManifests),
            { name: ref.name, ...(typeof ref.alias === "string" ? { alias: ref.alias } : {}) },
            fromModule,
            (alias) => scope.moduleForAlias(alias),
          ) as Record<string, any> | undefined)
        : undefined,
  };
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
 * The sites come from the shared reader (`derived-slots.ts`), which the kernel
 * decodes literals through at creation, so both read the same map against the
 * same contract.
 */
export function collectStepInputIssues(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: CallScopes,
  /** The typed `steps.<name>.result` context for this resource. Supplied by the
   *  caller because building it is analyzer state; without it the contract check
   *  still runs and only the type-argument comparison is skipped. */
  stepContext?: Record<string, any>,
): StepInputIssue[] {
  const ctx = callSiteContext(manifest, allManifests, defs, aliases, scopes);
  return stepCallSites(manifest, defSchema, ctx).flatMap((site) =>
    checkCallSite(site, manifest, allManifests, defs, aliases, scopes, stepContext),
  );
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
 */
export function collectRefInputIssues(
  manifest: Record<string, any>,
  fieldMap: ReferenceFieldMap | undefined,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: CallScopes,
): StepInputIssue[] {
  const ctx = callSiteContext(manifest, allManifests, defs, aliases, scopes);
  return slotCallSites(manifest, fieldMap, ctx).flatMap((site) =>
    checkCallSite(site, manifest, allManifests, defs, aliases, scopes),
  );
}

/**
 * The check itself, shared by both drivers: the arguments written at a call site
 * against the contract the target declares.
 */
function checkCallSite(
  site: CallSite,
  manifest: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: CallScopes,
  stepContext?: Record<string, any>,
): StepInputIssue[] {
  const out: StepInputIssue[] = [];
  const { contract, values, invoke, invokedManifest, invokedDefinition } = site;
  if (!contract) return out;
  const targetLabel =
    (invoke.name as string | undefined) ?? (invoke.kind as string | undefined) ?? "the invoked resource";
  const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;

  // Findings AT a substituted path are about a placeholder, not about anything
  // the author wrote — a `pattern`-constrained string or a `oneOf` of unrelated
  // shapes cannot be satisfied by any stand-in. Structural findings (missing
  // required, unknown property) are located at the container and survive the
  // filter. A literal written in a value type's plain encoding is decoded by the
  // substitution, as the kernel decodes it when it creates this resource.
  const celPaths = new Set<string>();
  // An enumerated call site: the kernel decodes this map when it creates the
  // resource that holds it.
  const substituted = substituteDecodedCelFields(values, contract.schema, undefined, {
    onSubstitute: (p) => celPaths.add(p),
    // A contract may name a shape declared elsewhere. Both halves need the
    // resolver or they disagree about the same slot.
    external: (ref) => defs.schemaForId(ref),
  });
  // The type-argument check, at the one site where a produced value's schema
  // meets a consuming slot's. The roots a plain chain may name here, each paired
  // with the schema it is navigated against: `steps.` is the step map (analyzer
  // state, supplied by the caller), `inputs.` the ENCLOSING kind's own declared
  // inputType — how a value produced outside this resource reaches a step at all.
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
      const slotSchema = (contract.schema.properties as Record<string, any> | undefined)?.[inputName];
      if (!produced || !slotSchema) continue;
      // A LIVE value is consumed by reading, so it exists exactly once — and
      // re-attempting a dispatch that already read it re-sends nothing. Both
      // facts are already declared: the value's liveness by its value type, and
      // the re-attempt by the retry policy. No kind is named.
      if (isLiveSlot(produced)) {
        const retry = site.step
          ? declaredRetry(site.step.value, site.step.schema, invokedManifest, invokedDefinition)
          : undefined;
        if (retry !== undefined) {
          out.push({
            path: `${site.path}.${inputName}`,
            targetLabel,
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
      // ONLY a type-argument disagreement, which is what the code says: both
      // sides must declare a value type for the question to be about arguments.
      if (!valueTypeOf(produced) || !valueTypeOf(slotSchema)) continue;
      const { compatible, issues } = checkSchemaCompatibility(produced, slotSchema, (ref) =>
        defs.schemaForId(ref),
      );
      if (compatible) continue;
      out.push({
        path: `${site.path}.${inputName}`,
        targetLabel,
        message: issues.join("; "),
        code: "CEL_TYPE_ARGUMENT_MISMATCH",
      });
    }
  }

  for (const issue of defs.validateResourceConfig(substituted, contract.schema)) {
    if (celPaths.has(issue.path)) continue;
    // A missing-required issue names the property that ISN'T there, so anchoring
    // on it finds no node. Anchor on the container that should have held it.
    const anchor = missingRequired(issue) ? containerOf(issue.path) : issue.path;
    out.push({
      path: anchor ? `${site.path}.${anchor}` : site.path,
      targetLabel,
      message: issue.message,
    });
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
