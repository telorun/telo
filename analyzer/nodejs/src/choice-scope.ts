/**
 * What deciding a choice needs from the declarations a manifest set registers:
 * whether a module call a condition makes can run before boot, the table it
 * runs through, what level of name a branch's kind declares, and which need a
 * `resources.<name>` read reaches.
 *
 * A condition may call a module function only where the analyzer can run it —
 * the rule a rule condition follows, read through the same derived flags: a
 * function written in CEL whose body reaches no host-backed and no
 * non-deterministic leaf is evaluated by the same body evaluator, in the module
 * that wrote the call. The analysis and the kernel build this from the same
 * registry, so both decide a call identically.
 *
 * Browser-safe.
 */
import { listRequests } from "./declaration-requests.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { ModuleCallDispatch } from "@telorun/templating";
import { moduleScopedDefResolver } from "./alias-resolver.js";
import type { AnalysisRegistry } from "./analysis-registry.js";
import type { ReachedNeed } from "./configuration-dimensions.js";
import { CallableFlagsIndex, renderChain } from "./callable-flags.js";
import { inheritedCapability, type DefResolver } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { FunctionBodyEvaluators } from "./function-body-evaluator.js";
import type { NameLevel } from "./identifier-name.js";
import { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
import { ModuleFunctionIndex } from "./module-function-index.js";
import { isModuleKind } from "./module-kinds.js";
import { needTypeOf, readNeeds, type NeedTypeShape } from "./need-type.js";
import type { NeedTable, NeedTableEntry } from "./need-table.js";

/** What a `resources.<name>` read of a need reaches: the need the environment
 *  or the importer is read for, or a supply at an import (a fulfilment, or a
 *  field-by-field supply), present whatever the environment holds. */
export type NeedReach =
  | { readonly kind: "reached"; readonly need: ReachedNeed }
  | { readonly kind: "supplied" };

export interface ChoiceScope {
  /** Why a call to `qualified` written in `caller`'s module cannot be decided
   *  before boot — a clause completing "… calls '<qualified>', which …" — or
   *  undefined when it can. */
  callRefusal(caller: ResourceManifest, qualified: string): string | undefined;
  /** The names `caller`'s module calls a function through. */
  moduleNames(caller: ResourceManifest): ReadonlySet<string>;
  /** The table `caller`'s module calls dispatch through. */
  dispatch(caller: ResourceManifest): ModuleCallDispatch;
  /** The level of name a declaration of `kind`, written in `module`, carries;
   *  undefined when the kind does not resolve. */
  nameLevel(kind: string, module: string | undefined): NameLevel | undefined;
  /** The need `name` of `module` reaches — the instance at `instancePath`
   *  where the module is imported several times — or undefined when `name` is
   *  no need of it. */
  needOf(module: string, instancePath: readonly string[] | undefined, name: string): NeedReach | undefined;
}

/** The scope a manifest set's choices are decided in, read off `registry` once
 *  it holds the set's definitions and alias tables. `related` is a wider set
 *  the dependencies' forwarded declarations are read from, where `manifests`
 *  is one module's own documents. `needTable` is the need table of the whole
 *  application, through which a dependency's need is read; the set's own
 *  modules' needs are read off their documents. */
export function choiceScopeOf(
  set: readonly ResourceManifest[],
  registry: AnalysisRegistry,
  related: readonly ResourceManifest[] = [],
  needTable?: NeedTable,
): ChoiceScope {
  const manifests = [...set, ...related.filter((m) => isForwardedDeclaration(m) && !set.includes(m))];
  const ctx = registry._context();
  const defs = ctx.definitions!;
  const aliases = ctx.aliases!;
  const aliasesByModule = ctx.aliasesByModule ?? new Map();
  const rootModules = new Set<string>();
  for (const m of manifests) {
    if (isModuleKind(m.kind) && typeof m.metadata?.name === "string") rootModules.add(m.metadata.name);
  }
  let built:
    | { names: ReadonlyMap<string, ReadonlySet<string>>; flags: CallableFlagsIndex; bodies: FunctionBodyEvaluators }
    | undefined;
  const calls = () => {
    if (!built) {
      const functions = new ModuleFunctionIndex(listRequests(manifests), defs, aliases, aliasesByModule, rootModules);
      const names = moduleCallNamesByModule(manifests);
      const flags = new CallableFlagsIndex(functions, names);
      built = { names, flags, bodies: new FunctionBodyEvaluators(functions, flags, names, (ref) => defs.schemaForId(ref)) };
    }
    return built;
  };
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, {
    aliasesByModule,
    rootModules,
  });
  const moduleDocs = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    if (isModuleKind(m.kind) && typeof m.metadata?.name === "string") moduleDocs.set(m.metadata.name, m);
  }
  const fieldsOf = (shape: NeedTypeShape | undefined) =>
    (shape?.fields ?? {}) as Readonly<Record<string, Record<string, unknown>>>;
  const byPath = new Map<string, NeedTableEntry>();
  for (const entry of needTable?.entries ?? []) byPath.set(entry.path.join("."), entry);
  /** The entry a dependency's need is at: by its instance's path, or the one
   *  path its module's need has. */
  const entryOf = (module: string, instancePath: readonly string[] | undefined, name: string) => {
    if (instancePath) {
      const entry = byPath.get([...instancePath, name].join("."));
      return entry?.moduleName === module ? entry : undefined;
    }
    const found = (needTable?.entries ?? []).filter((e) => e.moduleName === module && e.need.name === name);
    return new Set(found.map((e) => e.path.join("."))).size === 1 ? found[0] : undefined;
  };
  return {
    callRefusal(caller, qualified) {
      const flags = calls().flags.ofCall(caller, qualified);
      if (!flags) {
        return "reaches no function this module can call; a choice is decided before boot, so every call it makes must reach a function written in CEL";
      }
      if (flags.hostBacked) {
        return (
          `needs the runtime's host (${renderChain(flags.hostBackedVia)}): a native function runs only once ` +
          "the application has booted, so it cannot decide a choice before boot"
        );
      }
      if (!flags.deterministic) {
        return (
          `re-evaluates per call (${renderChain(flags.nondeterministicVia)}); a choice decided before boot ` +
          "must read the same value in every check"
        );
      }
      return undefined;
    },
    moduleNames: (caller) => moduleCallNamesOf(calls().names, caller),
    dispatch: (caller) => calls().bodies.dispatchFor(caller),
    nameLevel(kind, module) {
      const def = resolveDef.in(kind, module);
      if (!def) return undefined;
      return inheritedCapability(def, resolveDef as DefResolver) === "Telo.Type" ? "type" : "value";
    },
    needOf(module, instancePath, name) {
      if (rootModules.has(module)) {
        const need = readNeeds(moduleDocs.get(module)).find((n) => n.name === name);
        if (!need) return undefined;
        const shape = needTypeOf(resolveDef.in(need.kind, module));
        return { kind: "reached", need: { path: [name], optional: need.optional, fields: fieldsOf(shape) } };
      }
      let entry = entryOf(module, instancePath, name);
      if (!entry) return undefined;
      // A need forwarded whole is the need it is forwarded from, up to the one
      // the environment or the importer is read for.
      const seen = new Set<NeedTableEntry>();
      while (entry.supply === "whole" && entry.forwardedFrom && !seen.has(entry)) {
        seen.add(entry);
        const next = byPath.get(entry.forwardedFrom.join("."));
        if (!next) break;
        entry = next;
      }
      if (entry.supply !== "environment" && entry.supply !== "importer") return { kind: "supplied" };
      const shape = entry.need.type ? needTypeOf(defs.resolve(entry.need.type)) : undefined;
      return {
        kind: "reached",
        need: { path: entry.path, optional: entry.need.optional, fields: fieldsOf(shape) },
      };
    },
  };
}
