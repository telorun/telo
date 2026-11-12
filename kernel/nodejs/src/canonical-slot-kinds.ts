import {
  canonicalKindOf,
  rewriteCoReferrerKinds,
  rewriteRefSlotKinds,
  type DefResolver,
} from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";

/** Resolves a kind as written in `module`'s scope. */
export type ScopedKindResolver = (kind: string, module: string | undefined) => ResourceDefinition | undefined;

/**
 * Definitions as the co-referrer readers compare them: every `x-telo-ref` kind
 * and `callsCoReferrers` kind of a schema canonical, read in the module that
 * wrote it. A definition the kernel registered keeps the spellings its author
 * wrote (`Self.Topic`, `Co.Listener`), and those readers compare kinds as
 * strings, so two modules naming one kind by different aliases must meet as
 * `<module>.<Kind>`. A view's schema is the kind's effective one, which for a
 * merge-form `extends` child holds its ancestors' properties, so a top-level
 * property is read in the module of the farthest ancestor declaring it. A kind that resolves to nothing is left as written,
 * for the refusal that reports it.
 */
export class CanonicalSlotKinds {
  private readonly views = new WeakMap<object, ResourceDefinition>();

  constructor(
    private readonly resolveIn: ScopedKindResolver,
    private readonly effectiveSchemaOf: (definition: ResourceDefinition) => unknown = (definition) =>
      definition.schema,
  ) {}

  /** `definition` with its slot kinds canonical. */
  definition(definition: ResourceDefinition): ResourceDefinition {
    const known = this.views.get(definition);
    if (known) return known;
    const module = definition.metadata?.module;
    const schema = this.effectiveSchemaOf(definition) as Record<string, unknown> | undefined;
    const properties = schema?.properties as Record<string, unknown> | undefined;
    let canonical = this.schema(schema, module);
    if (canonical && properties && typeof properties === "object") {
      const own: Record<string, unknown> = {};
      for (const [key, node] of Object.entries(properties)) {
        own[key] = this.schema(node, this.declaringModule(definition, key));
      }
      canonical = { ...canonical, properties: own };
    }
    const view = { ...definition, schema: canonical } as ResourceDefinition;
    this.views.set(definition, view);
    this.views.set(view, view);
    return view;
  }

  /** `kind`, written in the slot under top-level property `key` of
   *  `definition`'s schema, as `<module>.<Kind>` — or undefined when it
   *  resolves to nothing there. */
  kindAt(definition: ResourceDefinition, key: string, kind: string): string | undefined {
    const resolved = this.resolveIn(kind, this.declaringModule(definition, key));
    return resolved ? canonicalKindOf(resolved) : undefined;
  }

  /** A copy of `schema` with its slot kinds canonical in `module`. */
  schema<T>(schema: T, module: string | undefined): T {
    const canonical = (kind: string): string | undefined => {
      const resolved = this.resolveIn(kind, module);
      return resolved ? canonicalKindOf(resolved) : undefined;
    };
    const copy = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(copy);
      if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
        return value;
      }
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = copy(inner);
      if (out["x-telo-ref"] !== undefined) {
        rewriteRefSlotKinds(out, canonical);
        rewriteCoReferrerKinds(out, canonical);
      }
      return out;
    };
    return copy(schema) as T;
  }

  /** A resolver answering canonical views, resolving `kind` in the module of
   *  the definition it was read off (`from`), else in `module`. */
  resolver(module?: string): DefResolver {
    return (kind, from) => {
      const resolved = this.resolveIn(kind, from?.metadata?.module ?? module);
      return resolved ? this.definition(resolved) : undefined;
    };
  }

  /** The module of the farthest definition along `extends` whose schema still
   *  declares top-level property `key` — the one that wrote it. */
  private declaringModule(definition: ResourceDefinition, key: string): string | undefined {
    let declarer = definition;
    const seen = new Set<object>([definition]);
    let current: ResourceDefinition | undefined = definition;
    while (typeof current?.extends === "string") {
      const parent = this.resolveIn(current.extends, current.metadata?.module);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      const declares = (this.effectiveSchemaOf(parent) as { properties?: Record<string, unknown> } | undefined)
        ?.properties?.[key];
      if (declares === undefined) break;
      declarer = parent;
      current = parent;
    }
    return declarer.metadata?.module;
  }
}
