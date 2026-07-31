import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  type ContractDirection,
  type DefResolver,
  effectiveContractField,
  mappingFieldFor,
  needsContractMapping,
} from "./extends-resolution.js";
import { buildReferenceFieldMap, isRefEntry } from "./reference-field-map.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

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
 *  - CONTRACT_MISSING_MAPPING: a definition that inherits its controller declares
 *    its own `inputType` / `outputType` without the `inputs:` / `result:` mapping
 *    that bridges it back to the inherited controller.
 *  - CONTRACT_INPUTS_SCHEMA_FORM: a leftover `inputs:` property map on a kind
 *    whose input contract is now `inputType:`.
 *  - CONTRACT_TYPE_NOT_FOUND: a contract names a type that is not declared in
 *    scope, so every call through it would fail at dispatch.
 *
 * Deliberately NOT diagnosed: an input that is neither `required:` nor
 * defaulted. It is indistinguishable from a genuinely optional one — `Ai.Text`
 * takes `prompt` OR `messages`, and `system` is optional on purpose — so the
 * check fired ~40 times across the standard library on correct manifests with no
 * way for an author to record the intent. A warning that cannot be silenced on
 * correct code teaches people to ignore warnings.
 */
export function validateInvocationContract(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> = new Map(),
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const resolveDef: DefResolver = (kind, from) => {
    const module = (from?.metadata as { module?: string } | undefined)?.module;
    const scope = (module ? aliasesByModule.get(module) : undefined) ?? aliases;
    return registry.resolve(kind) ?? registry.resolve(scope.resolveKind(kind) ?? kind);
  };

  // A published dependency's declarations are not the consumer's to fix.
  const importedModules = new Set<string>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const resolved = (m.metadata as { resolvedModuleName?: string } | undefined)?.resolvedModuleName;
    if (resolved) importedModules.add(resolved);
  }
  const isOwn = (m: ResourceManifest): boolean => {
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    return !ownModule || !importedModules.has(ownModule);
  };

  for (const m of manifests) {
    if (!isOwn(m)) continue;
    const name = m.metadata?.name as string | undefined;
    if (!name) continue;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    const md = m as unknown as Record<string, unknown>;

    if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") {
      checkMappingRequired(m, resource, filePath, resolveDef, diagnostics);
      checkContractResolves(m, md, manifests, resource, filePath, diagnostics);
      continue;
    }

    // A RESOURCE (an instance of some kind) — a leftover `inputs:` map is only
    // meaningful against a kind whose schema no longer declares one.
    const definition = resolveDef(m.kind, m as unknown as ResourceDefinition);
    if (!definition) continue;
    checkContractResolves(m, md, manifests, resource, filePath, diagnostics);
    checkLeftoverInputsSchema(m, definition, md, resource, filePath, diagnostics);
    checkRefSlotWiring(m, definition, manifests, resolveDef, resource, filePath, diagnostics);
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
 *  - the wiring site takes a paired author `inputs:` → the author supplies the
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
  definition: ResourceDefinition,
  manifests: ResourceManifest[],
  resolveDef: DefResolver,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  diagnostics: AnalysisDiagnostic[],
): void {
  const schema = definition.schema as Record<string, any> | undefined;
  if (!schema) return;

  for (const [path, entry] of buildReferenceFieldMap(schema)) {
    if (!isRefEntry(entry)) continue;
    // A slot that takes a paired `inputs:` is the author's to fill; its values
    // are checked at the call site instead, against the target's own contract.
    if (slotTakesPairedInputs(schema, path)) continue;

    const slotDeclares = slotDeclaredInputs(entry.refs, resolveDef, manifests);
    const runSite = isRunOnlySlot(entry.refs, resolveDef);
    if (!runSite && slotDeclares === undefined) continue;

    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    for (const name of refValuesAt(m as Record<string, any>, path)) {
      // Scoped to the declaring module: a resource of the same name in another
      // module is a different resource, and checking against its contract would
      // report on something the author never wired.
      const target = findInModule(manifests, name, ownModule);
      if (!target) continue;
      const targetDef = resolveDef(target.kind, target as unknown as ResourceDefinition);
      const targetRequired = requiredInputsOf(
        contractSchemaFor(target, targetDef, resolveDef, manifests),
      );
      if (!targetRequired || targetRequired.length === 0) continue;

      const unsatisfiable = runSite
        ? targetRequired
        : targetRequired.filter((key) => !(slotDeclares ?? []).includes(key));
      if (unsatisfiable.length === 0) continue;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: runSite ? "CONTRACT_INPUTS_AT_RUN_SITE" : "CONTRACT_SLOT_INPUTS_UNSATISFIABLE",
        source: SOURCE,
        message: runSite
          ? `${m.kind}/${resource.name}: '${name}' is wired at '${path}', which starts it with \`run()\` — ` +
            `a dispatch that passes no arguments — but its contract requires ${list(unsatisfiable)}. ` +
            `Nothing can supply them there. Invoke it from a step instead, or drop the requirement.`
          : `${m.kind}/${resource.name}: '${name}' is wired at '${path}', where the consumer builds the ` +
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
      : declared && typeof declared === "object" && typeof (declared as any).name === "string"
        ? (declared as any).name
        : undefined;
  if (!named) return undefined;
  const typeManifest = findInModule(manifests, named, declaringModule);
  return typeManifest ? inlineSchemaOf(typeManifest) : undefined;
}

/** The input names a contract makes mandatory. Undefined means "no contract
 *  declared" — distinct from an empty list, which means "declared, requires
 *  nothing". */
function requiredInputsOf(schema: Record<string, any> | undefined): string[] | undefined {
  if (!schema) return undefined;
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

/** Whether the object containing this ref slot also declares an inputs field —
 *  the `invoke`/`inputs` pairing, recognised through the topology role rather
 *  than a field name, so a composer spelling it differently still counts. */
function slotTakesPairedInputs(schema: Record<string, any>, path: string): boolean {
  const parentPath = path.slice(0, Math.max(0, path.lastIndexOf(".")));
  const parent = parentPath ? navigateSchema(schema, parentPath) : schema;
  const properties = (parent?.properties ?? {}) as Record<string, Record<string, any>>;
  return Object.values(properties).some((p) => p?.["x-telo-topology-role"] === "inputs");
}

/** Follow a field-map path (`a.b[].c`) through a schema's properties/items. */
function navigateSchema(
  schema: Record<string, any>,
  path: string,
): Record<string, any> | undefined {
  let node: Record<string, any> | undefined = schema;
  for (const raw of path.split(".")) {
    if (!node) return undefined;
    const key = raw.replace(/\[\]|\{\}/g, "");
    let next = (node.properties ?? {})[key] as Record<string, any> | undefined;
    if (!next) return undefined;
    if (raw.includes("[]")) next = (next.items ?? {}) as Record<string, any>;
    node = next;
  }
  return node;
}

/** The `{kind, name}` references actually written at a field-map path. */
function refValuesAt(manifest: Record<string, any>, path: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (node == null) return;
    if (segments.length === 0) {
      const items = Array.isArray(node) ? node : [node];
      for (const item of items) {
        // A reference is `{kind, name}` — BOTH fields. Requiring only `name`
        // would read an inline invoke step (`{ name, invoke, inputs }`) as a
        // reference to a resource called after the step, which it is not: that
        // `name` labels the step, and the step is an invoke site anyway.
        if (
          item &&
          typeof item === "object" &&
          typeof (item as any).name === "string" &&
          typeof (item as any).kind === "string"
        ) {
          out.push((item as any).name);
        }
      }
      return;
    }
    const [head, ...rest] = segments;
    const key = head!.replace(/\[\]|\{\}/g, "");
    const value = (node as Record<string, any>)[key];
    if (head!.includes("[]") && Array.isArray(value)) {
      for (const item of value) walk(item, rest);
    } else if (head!.includes("{}") && value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, rest);
    } else {
      walk(value, rest);
    }
  };
  walk(manifest, path.split("."));
  return out;
}

/**
 * A named contract must name a type that exists.
 *
 * The runtime raises `ERR_CONTRACT_UNRESOLVABLE` on the first dispatch through
 * an unresolvable contract, which is exactly the failure a checker should have
 * caught: nothing about it depends on runtime values. Instance-level slots were
 * already covered, because a module kind declares its `inputType` property with
 * `x-telo-ref: Telo.Type`; the KIND-level fields are on `Telo.Definition`, which
 * is deliberately excluded from reference validation, so they had no check at
 * all and the same typo behaved differently depending on where it was written.
 */
function checkContractResolves(
  m: ResourceManifest,
  md: Record<string, unknown>,
  manifests: ResourceManifest[],
  resource: { kind: string; name: string },
  filePath: string | undefined,
  diagnostics: AnalysisDiagnostic[],
): void {
  const declaringModule = (m.metadata as { module?: string } | undefined)?.module;
  for (const direction of ["inputType", "outputType"] as ContractDirection[]) {
    const named = namedTypeReference(md[direction]);
    if (!named) continue;
    if (findInModule(manifests, named, declaringModule)) continue;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "CONTRACT_TYPE_NOT_FOUND",
      source: SOURCE,
      message:
        `${m.kind}/${resource.name}: \`${direction}\` names the type '${named}', which is not declared ` +
        `in scope. The contract cannot be enforced, so every call through it would fail at dispatch. ` +
        `Declare a \`Telo.JsonSchema\` with that name, or inline the shape.`,
      data: { resource, filePath, path: direction },
    });
  }
}

/** The name a contract field references, when it is a reference at all. An
 *  inline shape or a raw schema names nothing and resolves on its own. */
function namedTypeReference(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  if (ref.schema && typeof ref.schema === "object") return undefined;
  return typeof ref.name === "string" ? ref.name : undefined;
}

/** A child that inherits its controller and REPLACES a contract must bridge it:
 *  contracts resolve to the nearest declaration and never merge, so the
 *  inherited controller only understands its own shape. Without the mapping the
 *  declaration is inert — precisely the silent no-op this rule exists to end. */
function checkMappingRequired(
  m: ResourceManifest,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  resolveDef: DefResolver,
  diagnostics: AnalysisDiagnostic[],
): void {
  const def = m as unknown as ResourceDefinition;
  const body = m as unknown as Record<string, unknown>;
  for (const direction of ["inputType", "outputType"] as ContractDirection[]) {
    if (!needsContractMapping(def, resolveDef, direction)) continue;
    const mappingField = mappingFieldFor(direction);
    if (body[mappingField] != null) continue;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "CONTRACT_MISSING_MAPPING",
      source: SOURCE,
      message:
        `${m.kind}/${resource.name}: declares its own \`${direction}\` but inherits its controller, ` +
        `and no \`${mappingField}:\` mapping bridges the two. The inherited controller only understands ` +
        `the kind it came from, so without a mapping the declaration would never be applied. Add a ` +
        `\`${mappingField}:\` mapping, or drop \`${direction}\` to inherit the contract unchanged.`,
      data: { resource, filePath, path: direction },
    });
  }
}

/** `inputs:` on a resource once meant "a JSON Schema property map" on the run
 *  kinds. It is values everywhere else, and now means values everywhere — so a
 *  leftover map against a kind that declares no `inputs` property is a migration
 *  the author has not finished, not an unknown field. */
function checkLeftoverInputsSchema(
  m: ResourceManifest,
  definition: ResourceDefinition,
  md: Record<string, unknown>,
  resource: { kind: string; name: string },
  filePath: string | undefined,
  diagnostics: AnalysisDiagnostic[],
): void {
  const value = md.inputs;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const properties = (definition.schema?.properties ?? {}) as Record<string, unknown>;
  if ("inputs" in properties) return;
  if (!("inputType" in properties)) return;
  diagnostics.push({
    severity: DiagnosticSeverity.Error,
    code: "CONTRACT_INPUTS_SCHEMA_FORM",
    source: SOURCE,
    message:
      `${m.kind}/${resource.name}: \`inputs:\` no longer declares an input contract — it always means ` +
      `values now. Move the property map to \`inputType:\` (a \`Telo.JsonSchema\` shape, a named type ` +
      `reference, or an inline schema).`,
    data: { resource, filePath, path: "inputs" },
  });
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

/** Find a manifest by name within a module, falling back to a unique global
 *  match. Names are unique per module, not per flattened graph, so an unscoped
 *  `find` can silently return another module's resource; an ambiguous global
 *  match resolves to nothing rather than to a guess. */
function findInModule(
  manifests: ResourceManifest[],
  name: string,
  module: string | undefined,
): ResourceManifest | undefined {
  const byName = manifests.filter((t) => (t.metadata as any)?.name === name);
  if (byName.length === 0) return undefined;
  const scoped = byName.filter(
    (t) => (t.metadata as { module?: string } | undefined)?.module === module,
  );
  if (scoped.length === 1) return scoped[0];
  return byName.length === 1 ? byName[0] : undefined;
}
