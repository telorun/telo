import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isEntryOwned } from "./entry-ownership.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { type ContractDirection, type DefResolver, effectiveContractField } from "./extends-resolution.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { reachSites, siteRefEntry } from "./reference-reach.js";
import { finishedValidation, SCHEMA_NESTING_EXCEEDED, schemaNestingExceededMessage, validateAgainstSchemaWithDefaults } from "./schema-validation.js";
import { type SignatureMismatch } from "./signature-substitution.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { isResolvedReference } from "./resolved-reference.js";
import type { ScopeSite } from "./scope-address.js";
import { manifestNames, scopeReadAt } from "./scoped-name-resolver.js";

const SOURCE = "telo-analyzer";

/**
 * Phase 3 — static checks on declared invocation contracts.
 *
 * The runtime binds a contract to every instance and enforces it at dispatch;
 * these are the failures worth catching before anything runs, and the ones the
 * runtime cannot see at all (a declaration that is inert, an input nobody can
 * supply).
 *
 * Diagnostics:
 *  - CONTRACT_INPUTS_AT_RUN_SITE: a resource wired where it is started with
 *    `run()`, whose contract refuses `{}`.
 *  - CONTRACT_SLOT_INPUTS_UNSATISFIABLE: a resource wired where the consumer
 *    builds the arguments from the slot's kind alone, requiring inputs that kind
 *    does not declare.
 *
 * What a kind document's contract refuses of the kinds it extends is
 * `kind-contract-findings.ts`.
 *
 * Deliberately NOT diagnosed: an input that is neither `required:` nor
 * defaulted. It is indistinguishable from a genuinely optional one — a text-generation kind
 * takes `prompt` OR `messages`, and `system` is optional on purpose — so the
 * check fired ~40 times across the standard library on correct manifests with no
 * way for an author to record the intent. A warning that cannot be silenced on
 * correct code teaches people to ignore warnings.
 */
export function validateInvocationContract(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const resolveDef: DefResolver = (kind, from) => {
    const scope = moduleAliasScope(from?.metadata, aliases, aliasesByModule);
    return registry.resolve(kind) ?? registry.resolve(scope.resolveKind(kind) ?? kind);
  };

  // A published dependency's declarations are not the consumer's to fix.
  const isOwn = (m: ResourceManifest): boolean => isEntryOwned(m, rootModules);

  for (const m of manifests) {
    if (!isOwn(m)) continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") continue;

    // A RESOURCE (an instance of some kind) — a leftover `inputs:` map is only
    // meaningful against a kind whose schema no longer declares one.
    const definition = resolveDef(m.kind, m as unknown as ResourceDefinition);
    if (!definition) continue;
    const kindSchema = registry.effectiveSchemaOf(definition) as Record<string, any> | undefined;
    checkRefSlotWiring(m, kindSchema, manifests, resolveDef, resource, filePath, diagnostics);
  }

  return diagnostics;
}

/**
 * The wiring rule: whether a ref slot may hold a resource whose input contract
 * differs from the slot's declared kind.
 *
 * `extends` decides which resources a slot ACCEPTS; it never carried the
 * dispatch contract. What matters per slot is whether the caller can supply the
 * target's arguments at all:
 *
 *  - the slot's declared kind declares no `inputType` and is not a run site →
 *    nothing to violate, accept;
 *  - a slot at the site declares an `inputs:` pointer → the author supplies the
 *    arguments and can see both sides, so the call site check covers it;
 *  - the consumer's controller builds the arguments and knows only the slot's
 *    kind → the wired resource must not require anything that kind does not
 *    declare, because nothing could ever supply it.
 *
 * The run-site case is the same rule with an empty argument set: a `run()`
 * dispatch passes nothing at all, so a target requiring any input can never be
 * satisfied there. Both are keyed on declared capability and declared contracts,
 * never on a kind's name.
 */
function checkRefSlotWiring(
  m: ResourceManifest,
  schema: Record<string, any> | undefined,
  manifests: ResourceManifest[],
  resolveDef: DefResolver,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  diagnostics: AnalysisDiagnostic[],
): void {
  if (!schema) return;

  const ownModule = (m.metadata as { module?: string } | undefined)?.module;
  for (const site of reachSites(schema, m)) {
    if (site.refs.length === 0) continue;
    // A slot whose own `inputs:` pointer names an argument map is the author's
    // to fill; its values are checked at the call site instead
    // (`CONTRACT_INPUTS_MISMATCH`), against the target's own contract.
    if (site.refs.some((ref) => ref.slot.inputs !== undefined)) continue;
    const entry = siteRefEntry(site);
    const slotDeclares = slotDeclaredInputs(entry.refs, resolveDef, manifests);
    const runSite = isRunOnlySlot(entry.refs, resolveDef);
    if (!runSite && slotDeclares === undefined) continue;

    const path = site.path;
    for (const name of referencedNames(site.data)) {
      // Scoped to the declaring module: a resource of the same name in another
      // module is a different resource, and checking against its contract would
      // report on something the author never wired.
      const target = findInModule(manifests, name, ownModule, scopeReadAt(m, path));
      if (!target) continue;
      const targetDef = resolveDef(target.kind, target as unknown as ResourceDefinition);
      const targetSchema = contractSchemaFor(target, targetDef, resolveDef, manifests);
      // A run is the contract applied to `{}` with defaults filled, as the kernel
      // binds it: whatever it still refuses can never be started there.
      if (runSite) {
        const outcome = targetSchema ? validateAgainstSchemaWithDefaults({}, targetSchema) : finishedValidation([]);
        if (!outcome.finished) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: SCHEMA_NESTING_EXCEEDED,
            source: SOURCE,
            message: schemaNestingExceededMessage(
              `${m.kind}/${resource.name}`,
              `the call \`run()\` makes of '${name}' at '${path}'`,
            ),
            data: { resource, filePath, path },
          });
          continue;
        }
        const issues = outcome.issues;
        if (issues.length > 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            code: "CONTRACT_INPUTS_AT_RUN_SITE",
            source: SOURCE,
            message:
              `${m.kind}/${resource.name}: '${name}' is wired at '${path}', which starts it with \`run()\` — ` +
              `a dispatch whose inputs are its contract applied to \`{}\` — but its contract refuses \`{}\`: ` +
              `${issues.map((issue) => issue.message).join("; ")}. Invoke it from a step instead, or let the ` +
              `contract accept an empty call.`,
            data: { resource, filePath, path },
          });
        }
        continue;
      }
      const targetRequired = requiredInputsOf(targetSchema);
      if (!targetRequired || targetRequired.length === 0) continue;

      const unsatisfiable = targetRequired.filter((key) => !(slotDeclares ?? []).includes(key));
      if (unsatisfiable.length === 0) continue;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CONTRACT_SLOT_INPUTS_UNSATISFIABLE",
        source: SOURCE,
        message:
          `${m.kind}/${resource.name}: '${name}' is wired at '${path}', where the consumer builds the ` +
          `arguments from the slot's declared kind alone, but its contract requires ${list(unsatisfiable)} ` +
          `which that kind does not declare. Nothing could supply them.`,
        data: { resource, filePath, path },
      });
    }
  }
}

const list = (keys: string[]): string => keys.map((k) => `'${k}'`).join(", ");

/** The inputs a consumer can supply knowing only the slot — the UNION of every
 *  accepted kind's declared inputs.
 *
 *  Union rather than the first match: a slot accepting several kinds may see any
 *  of them, and a name any accepted kind declares is one a consumer could
 *  plausibly supply. Taking the first kind's contract would make the check
 *  depend on the order `anyOf` branches happen to be written in. Undefined when
 *  no accepted kind declares a contract at all — the "nothing to violate" case. */
function slotDeclaredInputs(
  refs: string[],
  resolveDef: DefResolver,
  manifests: ResourceManifest[],
): string[] | undefined {
  let seen: Set<string> | undefined;
  for (const ref of refs) {
    const def = resolveDef(ref);
    if (!def) continue;
    const schema = contractSchemaFor(undefined, def, resolveDef, manifests);
    if (!schema) continue;
    seen ??= new Set<string>();
    for (const key of Object.keys((schema.properties ?? {}) as Record<string, unknown>)) {
      seen.add(key);
    }
  }
  return seen ? [...seen] : undefined;
}

/** True when every kind a slot accepts is started rather than invoked — the
 *  capabilities whose dispatch verb is `run()`, which passes no arguments.
 *  Keyed on the declared capability, so a user-defined abstract resolves the
 *  same way a built-in does. */
function isRunOnlySlot(refs: string[], resolveDef: DefResolver): boolean {
  if (refs.length === 0) return false;
  return refs.every((ref) => {
    const def = resolveDef(ref);
    const capability = def?.capability ?? ref;
    return capability === "Telo.Runnable" || capability === "Telo.Service";
  });
}

/** The resolved contract schema for a target: its own declaration first, then
 *  the nearest along `extends`. Inline schemas only — a named reference resolves
 *  through machinery this pass does not carry, and half-resolving would be worse
 *  than not reporting. */
function contractSchemaFor(
  manifest: ResourceManifest | undefined,
  definition: ResourceDefinition | undefined,
  resolveDef: DefResolver,
  manifests: ResourceManifest[],
  direction: ContractDirection = "inputType",
): Record<string, any> | undefined {
  const declaringModule = ((manifest ?? definition)?.metadata as { module?: string } | undefined)
    ?.module;
  const own = manifest ? (manifest as unknown as Record<string, unknown>)[direction] : undefined;
  const declared =
    own !== undefined && own !== null
      ? own
      : effectiveContractField(definition, resolveDef, direction);
  const inline = inlineSchemaOf(declared);
  if (inline) return inline;
  // A `!ref` / bare name: resolve it to the named type resource in scope.
  const named =
    typeof declared === "string"
      ? declared
      : isResolvedReference(declared)
        ? declared.name
        : undefined;
  if (!named) return undefined;
  const typeManifest = findInModule(manifests, named, declaringModule, scopeReadAt(manifest));
  return typeManifest ? inlineSchemaOf(typeManifest) : undefined;
}

/** The input names a contract makes mandatory. Undefined means "no contract
 *  declared" — distinct from an empty list, which means "declared, requires
 *  nothing". */
function requiredInputsOf(schema: Record<string, any> | undefined): string[] | undefined {
  if (!schema) return undefined;
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

/** The `{kind, name}` references a site holds — one, or each item of a list. */
function referencedNames(value: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    // A reference carries the resolved-reference marker. An inline invoke step
    // (`{ name, invoke, inputs }`) is no reference to a resource called after
    // the step: that `name` labels the step, and the step is an invoke site anyway.
    if (isResolvedReference(item)) out.push(item.name);
  }
  return out;
}

/** A signature mismatch as the sentence a diagnostic carries, and the path it
 *  anchors at, against the kind whose signature it fails to stand in for. */
export function describeSignatureMismatch(
  mismatch: SignatureMismatch,
  requiredName: string,
): { path: string; text: string } {
  switch (mismatch.kind) {
    case "returns":
      return {
        path: "returns.schema",
        text:
          `\`returns\` replaces the result declared by '${requiredName}' with a shape that cannot ` +
          `stand in for it — ${mismatch.issues.join("; ")}.`,
      };
    case "requires-more":
      return {
        path: "params",
        text:
          `\`params\` requires ${mismatch.required} argument(s) while '${requiredName}' requires only ` +
          `${mismatch.requires}, so a call written against that kind need not supply them.`,
      };
    case "accepts-fewer":
      return {
        path: "params",
        text:
          `\`params\` accepts ${mismatch.accepts} argument(s) while '${requiredName}' requires ` +
          `${mismatch.required}, so a call written against that kind passes more than this ` +
          `signature admits.`,
      };
    case "parameter":
      return {
        path: `params[${mismatch.index}].schema`,
        text:
          `parameter '${mismatch.name}' does not accept the argument '${requiredName}' declares at the ` +
          `same position — ${mismatch.issues.join("; ")}.`,
      };
    case "parameter-name":
      return {
        path: `params[${mismatch.index}].name`,
        text:
          `parameter '${mismatch.name}' is named '${mismatch.expected}' by '${requiredName}', and a ` +
          `holder calls the function with the names '${requiredName}' declares.`,
      };
  }
}

/**
 * CONTRACT_INPUTS_SCHEMA_FORM: `inputs:` on a resource once meant "a JSON Schema
 * property map" on the run kinds. It is values everywhere else, and now means
 * values everywhere — so a leftover map against a kind that declares no `inputs`
 * property is a migration the author has not finished, not an unknown field. The
 * verdict reads the declaration's own `inputs` and its kind's schema alone.
 */
export function leftoverInputsSchemaFindings(
  m: ResourceManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  if (!isEntryOwned(m, rootModules)) return [];
  const name = m.metadata?.name as string | undefined;
  if (!name || m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") return [];
  const scope = moduleAliasScope(m.metadata, aliases, aliasesByModule);
  const definition = registry.resolve(m.kind) ?? registry.resolve(scope.resolveKind(m.kind) ?? m.kind);
  if (!definition) return [];
  const value = (m as unknown as Record<string, unknown>).inputs;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const kindSchema = registry.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  const properties = (kindSchema?.properties ?? {}) as Record<string, unknown>;
  if ("inputs" in properties) return [];
  if (!("inputType" in properties)) return [];
  const resource = { kind: m.kind, name };
  const filePath = (m.metadata as { source?: string } | undefined)?.source;
  return [{
    severity: DiagnosticSeverity.Error,
    code: "CONTRACT_INPUTS_SCHEMA_FORM",
    source: SOURCE,
    message:
      `${m.kind}/${resource.name}: \`inputs:\` no longer declares an input contract — it always means ` +
      `values now. Move the property map to \`inputType:\` (a \`Telo.JsonSchema\` shape, a named type ` +
      `reference, or an inline schema).`,
    data: { resource, filePath, path: "inputs" },
  }];
}

/** The schema behind an INLINE type declaration, which is all this pass can read
 *  without a manifest lookup. A named reference resolves elsewhere; skipping it
 *  here keeps the check total rather than half-informed. */
function inlineSchemaOf(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, any>;
  if (obj.schema && typeof obj.schema === "object") return obj.schema;
  if (obj.properties && typeof obj.properties === "object") return obj;
  return undefined;
}

/** Find a manifest by name as read from a module, inside `within` when given —
 *  the scoped name rule over the set, so an ambiguous global match resolves to
 *  nothing rather than to a guess. */
function findInModule(
  manifests: ResourceManifest[],
  name: string,
  module: string | undefined,
  within: ScopeSite | undefined,
): ResourceManifest | undefined {
  return manifestNames(manifests).resolve(name, module, within);
}
