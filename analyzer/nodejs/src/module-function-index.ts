/**
 * **What a module call names, once per declaring module per analysis.**
 *
 * A call written `Billing.format(x)` is a call on a resource: `Self.<name>` and
 * `<ModuleName>.<name>` name one the declaring module declares, `<Alias>.<name>`
 * one its import lists in `exports.resources`, and `Telo.<name>` nothing — no
 * built-in module declares a function resource. The resource must be a callable
 * (its capability resolves to `Telo.Callable` along `extends`). These are the
 * kernel's binding rules (`kernel/nodejs/src/kernel.ts` `resolveModuleFunction`),
 * restated as a static question over the flattened manifest set, so `telo check`
 * refuses exactly what boot refuses.
 *
 * A name resolves only among a module's DECLARED resources — never a `with:`
 * scope's — because the kernel binds a call in the module context, where a
 * scope's resources do not live.
 *
 * The flattened set carries a dependency's exported instances and none of its
 * internals, so a call a dependency's own expression makes may name something
 * this analysis cannot see. That is `unknown`, never `unresolved`: the
 * dependency's own `telo check` answers it, and every diagnostic built on this
 * index is scoped to the entry's own modules anyway.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import {
  claimsDeterministic,
  isCallableKind,
  parameterSchemaOf,
  resolveSignature,
  callableBodyField,
  signatureSchemaOf,
  type CallableSignature,
  type SignatureParam,
} from "./callable-signature.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  controllerBearingAncestor,
  type DefResolver,
  hasOwnControllerOrTemplate,
  inheritedCapability,
} from "./extends-resolution.js";
import { isForwardedExport, isForwardedShape } from "./forwarded-declaration.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import {
  declaringModuleKey,
  ROOT_MODULE_KEY,
  SELF_ALIAS,
  TELO_MODULE_NAME,
} from "./module-call-names.js";
import { isModuleKind } from "./module-kinds.js";
import { inlineNamedShapes, jsonSchemaToCelType } from "./schema-compat.js";

/** One parameter as a caller is checked against it. */
export interface FunctionParameter {
  readonly name: string;
  readonly optional: boolean;
  /** The schema an argument must satisfy, named shapes inlined and `nullable`
   *  folded in. Absent when the parameter declares none. */
  readonly schema?: Record<string, any>;
}

/** A module call that names a callable. */
export interface ResolvedFunction {
  readonly status: "resolved";
  readonly manifest: ResourceManifest;
  /** Undefined when the callable declares no parameter list: a call then
   *  passes nothing. */
  readonly params: readonly FunctionParameter[];
  /** The result's schema, named shapes inlined and `nullable` folded in. */
  readonly returns?: Record<string, any>;
  /** The CEL type a call yields. */
  readonly celType: string;
}

export type FunctionResolution =
  | ResolvedFunction
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "not-exported"; readonly alias: string; readonly name: string }
  | {
      readonly status: "not-callable";
      readonly manifest: ResourceManifest;
      /** The resource's kind, canonical — as the kernel names it. */
      readonly kind: string;
      readonly capability: string | undefined;
    }
  /** Not decidable from this manifest set — nothing is claimed. */
  | { readonly status: "unknown" };

const UNKNOWN: FunctionResolution = { status: "unknown" };

export class ModuleFunctionIndex {
  /** Every declaration by owning module (the entry's own under the root key) and
   *  name. */
  private readonly declared = new Map<string, Map<string, ResourceManifest[]>>();
  /** Exported instances forwarded from a dependency, by module and name. */
  private readonly exported = new Map<string, Map<string, ResourceManifest>>();
  private readonly imports = new Map<string, Map<string, ResourceManifest>>();
  private readonly memo = new Map<string, FunctionResolution>();
  private readonly resolveDef: DefResolver;

  constructor(
    manifests: readonly ResourceManifest[],
    private readonly defs: DefinitionRegistry,
    private readonly aliases: AliasResolver,
    private readonly aliasesByModule: ReadonlyMap<string, AliasResolver>,
    private readonly rootModules: ReadonlySet<string>,
  ) {
    this.resolveDef = (kind, from) => {
      const scope = moduleAliasScope(from?.metadata, aliases, aliasesByModule);
      return defs.resolve(kind) ?? defs.resolve(scope.resolveKind(kind) ?? kind);
    };
    for (const m of manifests) {
      const name = m.metadata?.name;
      if (typeof name !== "string" || !name || isModuleKind(m.kind as string)) continue;
      if (isForwardedShape(m)) continue;
      const module = this.moduleKeyOf(m);
      if (isForwardedExport(m)) {
        // Keyed by the module that EXPORTS it, which a re-export's copy is
        // stamped with — not by the module that declared it, which is where its
        // own names resolve and which a re-export does not change.
        const exporter = (m.metadata as { module?: unknown } | undefined)?.module;
        bucket(this.exported, typeof exporter === "string" && exporter ? exporter : module).set(
          name,
          m,
        );
        continue;
      }
      if (m.kind === "Telo.Import") bucket(this.imports, module).set(name, m);
      const byName = bucket(this.declared, module);
      byName.set(name, [...(byName.get(name) ?? []), m]);
    }
  }

  /** The module a manifest's names are written in, the entry's own collapsed to
   *  one key — they share one alias table. */
  moduleKeyOf(manifest: ResourceManifest): string {
    const key = declaringModuleKey(manifest);
    return key === ROOT_MODULE_KEY || this.rootModules.has(key) ? ROOT_MODULE_KEY : key;
  }

  /** Whether `manifest` is a function — a resource whose kind is callable. A
   *  function publishes no reading, so it is not a name `resources` holds. */
  isFunction(manifest: ResourceManifest): boolean {
    const definition = this.definitionOf(manifest);
    return !!definition && isCallableKind(definition, this.resolveDef);
  }

  /** The kind a resource is declared as, resolved in its declaring module. */
  definitionOf(manifest: ResourceManifest): ResourceDefinition | undefined {
    return this.resolveDef(manifest.kind as string, manifest as unknown as ResourceDefinition);
  }

  /**
   * What a callable computes its result from — the value of the field its kind
   * annotates `x-telo-returns-from`, with its CEL source when it is an
   * expression — or undefined when its kind declares no such field, which is what
   * makes it NATIVE: its result comes from code the analyzer never has. A body
   * written as a literal has no source, calls nothing and is its own result.
   */
  bodyOf(manifest: ResourceManifest): { readonly value: unknown; readonly source?: string } | undefined {
    const field = callableBodyField(this.definitionOf(manifest), this.resolveDef);
    if (field === undefined) return undefined;
    const value = (manifest as unknown as Record<string, unknown>)[field];
    if (isCompiledValue(value) && typeof value.source === "string") {
      return { value, source: value.source };
    }
    if (isTaggedSentinel(value) && value.engine === CEL_ENGINE) {
      return { value, source: value.source };
    }
    return { value };
  }

  /** The signature in force for a callable resource. */
  signatureOf(manifest: ResourceManifest): CallableSignature {
    return resolveSignature(manifest, this.definitionOf(manifest), this.resolveDef);
  }

  /** What a native callable claims: the `deterministic` of the definition whose
   *  controller it runs — its own kind's, or the controller-bearing ancestor it
   *  inherits the controller (and with it the claim) from. Absent is false. */
  claimsDeterministic(manifest: ResourceManifest): boolean {
    const definition = this.definitionOf(manifest);
    const implementer = hasOwnControllerOrTemplate(definition)
      ? definition
      : controllerBearingAncestor(definition, this.resolveDef);
    return claimsDeterministic(implementer);
  }

  /** Whether `manifest` is written in one of the entry's own modules. */
  isOwned(manifest: ResourceManifest): boolean {
    return this.moduleKeyOf(manifest) === ROOT_MODULE_KEY;
  }

  /** What `qualified`, written in `caller`'s module, names. */
  resolve(caller: ResourceManifest, qualified: string): FunctionResolution {
    const module = this.moduleKeyOf(caller);
    const key = `${module}\0${qualified}`;
    let resolution = this.memo.get(key);
    if (!resolution) {
      resolution = this.resolveUncached(caller, module, qualified);
      this.memo.set(key, resolution);
    }
    return resolution;
  }

  /**
   * The functions `<receiver>.` may name from `caller`'s module, in declaration
   * order: the module's own callables through `Self` or its own name, an
   * import's exported callables through its alias. Each is resolved through
   * {@link resolve}, so what is offered is exactly what a call resolves to.
   */
  callablesThrough(
    caller: ResourceManifest,
    receiver: string,
  ): Array<{ name: string; function: ResolvedFunction }> {
    const module = this.moduleKeyOf(caller);
    const ownNames = module === ROOT_MODULE_KEY ? this.rootModules : new Set<string>([module]);
    let names: Iterable<string>;
    if (receiver === SELF_ALIAS || ownNames.has(receiver)) {
      names = this.declared.get(module)?.keys() ?? [];
    } else {
      const scope = moduleAliasScope(caller.metadata, this.aliases, this.aliasesByModule);
      const targetModule = scope.moduleForAlias(receiver);
      names = targetModule ? (this.exported.get(targetModule)?.keys() ?? []) : [];
    }
    const out: Array<{ name: string; function: ResolvedFunction }> = [];
    for (const name of names) {
      const resolution = this.resolve(caller, `${receiver}.${name}`);
      if (resolution.status === "resolved") out.push({ name, function: resolution });
    }
    return out;
  }

  private resolveUncached(
    caller: ResourceManifest,
    module: string,
    qualified: string,
  ): FunctionResolution {
    const dot = qualified.indexOf(".");
    const receiver = qualified.slice(0, dot);
    const name = qualified.slice(dot + 1);
    const owned = module === ROOT_MODULE_KEY;

    if (receiver === TELO_MODULE_NAME) {
      return { status: "unresolved", reason: "no built-in module declares a function resource." };
    }

    const ownNames =
      module === ROOT_MODULE_KEY ? this.rootModules : new Set<string>([module]);
    if (receiver === SELF_ALIAS || ownNames.has(receiver)) {
      const candidates = this.declared.get(module)?.get(name) ?? [];
      const target = candidates[0];
      if (!target) {
        return owned
          ? { status: "unresolved", reason: `this module declares no resource named '${name}'.` }
          : UNKNOWN;
      }
      return this.classify(target);
    }

    const scope = moduleAliasScope(caller.metadata, this.aliases, this.aliasesByModule);
    const targetModule = scope.moduleForAlias(receiver);
    if (!targetModule) {
      // The name set a call resolves through is the module's own `imports:`
      // keys, so a receiver that is none of them does not reach here. One whose
      // import did not resolve registered no alias, and that failure is its own
      // diagnostic.
      return this.imports.get(module)?.has(receiver)
        ? UNKNOWN
        : { status: "unresolved", reason: `'${receiver}' is not an import of this module.` };
    }
    const exported = this.exported.get(targetModule)?.get(name);
    if (exported) return this.classify(exported);
    const importDoc = this.imports.get(module)?.get(receiver);
    const declared = (importDoc?.metadata as { declaredResources?: unknown } | undefined)
      ?.declaredResources;
    if (!Array.isArray(declared)) return UNKNOWN;
    return declared.includes(name)
      ? { status: "not-exported", alias: receiver, name }
      : {
          status: "unresolved",
          reason: `the library imported as '${receiver}' declares no resource named '${name}'.`,
        };
  }

  private classify(target: ResourceManifest): FunctionResolution {
    const definition = this.resolveDef(target.kind as string, target as unknown as ResourceDefinition);
    if (!definition) return UNKNOWN;
    if (!isCallableKind(definition, this.resolveDef)) {
      return {
        status: "not-callable",
        manifest: target,
        kind: `${definition.metadata?.module}.${definition.metadata?.name}`,
        capability: inheritedCapability(definition, this.resolveDef),
      };
    }
    const signature = resolveSignature(target, definition, this.resolveDef);
    const inline = (schema: Record<string, any>) =>
      inlineNamedShapes(schema, (id) => this.defs.schemaForId(id));
    const params = (signature.params ?? []).map(
      (param: SignatureParam, index): FunctionParameter => {
        const schema = parameterSchemaOf({ ...param, optional: false }, inline);
        return {
          name: typeof param.name === "string" ? param.name : `#${index}`,
          optional: param.optional === true,
          ...(schema ? { schema } : {}),
        };
      },
    );
    const returnsSchema = signature.returns?.schema;
    const returns =
      returnsSchema && typeof returnsSchema === "object" && !Array.isArray(returnsSchema)
        ? signatureSchemaOf({ ...signature.returns, schema: inline(returnsSchema as Record<string, any>) })
        : undefined;
    return {
      status: "resolved",
      manifest: target,
      params,
      ...(returns ? { returns } : {}),
      celType: returns ? jsonSchemaToCelType(returns) : "dyn",
    };
  }
}

function bucket<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = map.get(key);
  if (!inner) map.set(key, (inner = new Map()));
  return inner;
}
