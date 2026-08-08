/**
 * The kernel half of execution zones — `kernel/specs/execution-zones.md`.
 *
 * Everything a `ResourceContext` needs to open a zone declared by one of its
 * own slots, and to assert it is inside one: annotation resolution in the
 * kind's *declaring* scope, correlation-pointer resolution over the resource's
 * own (Phase-5-injected) manifest, `extends`-aware kind matching, and the
 * ambient-stack search.
 *
 * It lives beside `resource-handle.ts` rather than inside `resource-context.ts`
 * because it is a subsystem with its own state, not a few accessors: the
 * context delegates and keeps its own file about the resource lifecycle.
 *
 * **Resolution is memoized per annotated field.** Everything a match needs —
 * the resolved zone kind, the accepted-kind set, and the correlation handle —
 * is a function of `(kind, field)` and the injected manifest, all fixed once
 * `create()` has returned. A statement resolves them on *every* dispatch
 * otherwise, and this sits on the SQL hot path.
 */
import {
  InvokeError,
  RuntimeError,
  UNCANCELLABLE_CONTEXT,
  deriveContext,
  getRefIdentity,
  sameResource,
  type InvokeContext,
  type ResourceDefinition,
  type ResourceHandle,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import { readProvidesZone, readRequiresZone, type RequiresZoneSlot } from "@telorun/analyzer";
import { isRefSentinel } from "@telorun/templating";
import { ambientInvokeContext, runWithAmbientContext } from "./evaluation-context.js";
import { handleOfInstance } from "./resource-handle.js";

/** What the owning context supplies. Structural, so `ResourceContext` stays the
 *  only thing that knows how any of it is reached. */
export interface ZoneHost {
  /** This resource's `metadata.name`, for diagnostics. */
  readonly resourceName: string;
  /** Canonical `<module>.<Kind>` of this resource's kind. */
  readonly resolvedKind: string;
  /** This resource's own handle — a zone's `provider`. */
  readonly self: ResourceHandle;
  /** The resource's manifest — the SAME object Phase-5 injection mutates, so a
   *  correlation pointer read at invoke time sees live instances in ref slots. */
  readonly manifest: Record<string, unknown>;
  /** The definition registered for a kind, resolved globally. */
  resolveDefinition(kind: string): ResourceDefinition | undefined;
  /** The definition for a kind resolved in `module`'s alias scope. */
  resolveDefinitionIn(kind: string, module?: string): ResourceDefinition | undefined;
  /** A sibling instance by name, scope-local first. */
  resolveLocalInstance(name: string): ResourceInstance | undefined;
  /** A sibling's manifest by name, scope-local first — for a key pointer that
   *  traverses a `!ref` into the referenced resource's own field. */
  resolveLocalManifest(name: string): Record<string, unknown> | undefined;
}

/** Everything a requirement match needs, resolved once per annotated field. */
interface ResolvedRequirement {
  requirement: RequiresZoneSlot;
  /** Canonical kind the requirement names. */
  requiredKind: string;
  /** Does an open zone's kind satisfy this requirement — is it the required
   *  kind, or does it transitively `extends` it (Liskov acceptance)? Memoized
   *  per entry kind, so the walk up the chain happens once. */
  accepts: (entryKind: string) => boolean;
  /** The instance the key pointers resolved to; absent = uncorrelated. */
  keyHandle?: ResourceHandle;
}

export class ZoneContext {
  readonly #host: ZoneHost;
  /** Field → resolved requirement. See the file docstring. */
  readonly #requirements = new Map<string, ResolvedRequirement>();
  /** Slot → resolved correlation handle for a providing slot. */
  readonly #providers = new Map<string, { key?: ResourceHandle }>();

  constructor(host: ZoneHost) {
    this.#host = host;
  }

  async withZone<T>(
    slot: string,
    fn: (ctx: InvokeContext, entry: ZoneEntry) => Promise<T>,
    base?: InvokeContext,
  ): Promise<T> {
    const provider = this.resolveProvider(slot);
    // Every field derived: kind = the declaring kind, provider = this resource,
    // key = the annotation's pointer over this resource's own manifest — which
    // is the runtime half of why a schema cannot claim another module's zone.
    const entry: ZoneEntry = Object.freeze({
      kind: this.#host.resolvedKind,
      provider: this.#host.self,
      ...(provider.key ? { key: provider.key } : {}),
    });
    const from = base ?? ambientInvokeContext() ?? UNCANCELLABLE_CONTEXT;
    const derived = deriveContext(from, { zones: [...(from.zones ?? []), entry] });
    return runWithAmbientContext(derived, () => fn(derived, entry));
  }

  requireZone(field: string, ctx?: InvokeContext): ZoneEntry {
    const resolved = this.resolveRequirement(field);
    const entry = this.match(resolved, ctx);
    if (entry) return entry;
    const where = resolved.keyHandle
      ? ` on ${resolved.keyHandle.ref.kind} '${resolved.keyHandle.ref.name}'`
      : "";
    const reason = resolved.requirement.reason ? `: ${resolved.requirement.reason}` : "";
    throw new InvokeError(
      "ERR_ZONE_REQUIRED",
      `${this.#host.resolvedKind} '${this.#host.resourceName}': no ${resolved.requiredKind} zone open${where}${reason}`,
    );
  }

  findZone(field: string, ctx?: InvokeContext): ZoneEntry | undefined {
    return this.match(this.resolveRequirement(field), ctx);
  }

  zonesFor(instance: ResourceInstance, ctx?: InvokeContext): readonly ZoneEntry[] {
    const zones = (ctx ?? ambientInvokeContext())?.zones;
    if (!zones || zones.length === 0) return [];
    const handle = handleOfInstance(instance as object);
    if (!handle) return [];
    const out: ZoneEntry[] = [];
    for (let i = zones.length - 1; i >= 0; i--) {
      const entry = zones[i]!;
      if (entry.key && sameResource(entry.key, handle)) out.push(entry);
    }
    return out;
  }

  // ── resolution ────────────────────────────────────────────────────────────

  private resolveProvider(slot: string): { key?: ResourceHandle } {
    const cached = this.#providers.get(slot);
    if (cached) return cached;
    const provides = readProvidesZone(this.slotSchema(slot));
    if (!provides) {
      throw new RuntimeError(
        "ERR_ZONE_ANNOTATION_MISSING",
        `[${this.#host.resourceName}] withZone('${slot}'): schema.properties.${slot} of ` +
          `${this.#host.resolvedKind} carries no x-telo-provides-zone — the controller and its ` +
          `schema disagree`,
      );
    }
    const key = provides.key ? this.resolveCorrelationHandle([provides.key]) : undefined;
    const resolved = key ? { key } : {};
    this.#providers.set(slot, resolved);
    return resolved;
  }

  private resolveRequirement(field: string): ResolvedRequirement {
    const cached = this.#requirements.get(field);
    if (cached) return cached;
    const requirement = readRequiresZone(this.slotSchema(field));
    if (!requirement) {
      throw new RuntimeError(
        "ERR_ZONE_ANNOTATION_MISSING",
        `[${this.#host.resourceName}] requireZone('${field}'): schema.properties.${field} of ` +
          `${this.#host.resolvedKind} carries no x-telo-requires-zone — the controller and its ` +
          `schema disagree`,
      );
    }
    const requiredKind = this.resolveZoneKind(requirement.zone);
    const resolved: ResolvedRequirement = {
      requirement,
      requiredKind,
      accepts: this.acceptancePredicate(requiredKind),
      // When no pointer resolves, the requirement discharges uncorrelated — any
      // zone of the right type. Inventing a correlation the manifest does not
      // state would manufacture failures from a guess.
      keyHandle:
        requirement.key.length > 0 ? this.resolveCorrelationHandle(requirement.key) : undefined,
    };
    this.#requirements.set(field, resolved);
    return resolved;
  }

  /** Innermost first — the order a nested zone must win in. */
  private match(resolved: ResolvedRequirement, ctx?: InvokeContext): ZoneEntry | undefined {
    const zones = (ctx ?? ambientInvokeContext())?.zones ?? [];
    for (let i = zones.length - 1; i >= 0; i--) {
      const entry = zones[i]!;
      if (!resolved.accepts(entry.kind)) continue;
      if (resolved.keyHandle && !(entry.key && sameResource(entry.key, resolved.keyHandle))) {
        continue;
      }
      return entry;
    }
    return undefined;
  }

  /** The schema node for one of this kind's own top-level fields — the site the
   *  zone annotations live on. */
  private slotSchema(field: string): Record<string, any> | undefined {
    const def = this.ownDefinition();
    return (def.schema as { properties?: Record<string, Record<string, any>> } | undefined)
      ?.properties?.[field];
  }

  private ownDefinition(): ResourceDefinition {
    const def = this.#host.resolveDefinition(this.#host.resolvedKind);
    if (!def) {
      throw new RuntimeError(
        "ERR_ZONE_ANNOTATION_MISSING",
        `[${this.#host.resourceName}] no registered definition for kind '${this.#host.resolvedKind}'`,
      );
    }
    return def;
  }

  /** Resolve the annotation's zone kind to canonical `<module>.<Kind>`.
   *  `resolveSchemaRefKinds` already rewrote it in the DECLARING module's scope
   *  during analysis; the scoped lookup is the fallback for an un-analyzed load. */
  private resolveZoneKind(zone: string): string {
    const def = this.#host.resolveDefinitionIn(zone, this.ownDefinition().metadata.module);
    if (!def) {
      throw new RuntimeError(
        "ERR_ZONE_UNRESOLVED",
        `[${this.#host.resourceName}] x-telo-requires-zone names '${zone}', which resolves to no ` +
          `registered kind`,
      );
    }
    return `${def.metadata.module}.${def.metadata.name}`;
  }

  /**
   * Acceptance for one requirement: the required kind, or anything that
   * transitively `extends` it.
   *
   * A predicate rather than a precomputed set because the kernel's registry has
   * no `extendedBy` index — only the upward `extends` link — so the set of
   * acceptable kinds is not enumerable from the requirement alone. Each
   * candidate walks UP instead, and only ever for a kind actually seen on the
   * stack. The verdict is cached per entry kind, so a repeated dispatch through
   * the same shape costs one map lookup.
   */
  private acceptancePredicate(requiredKind: string): (entryKind: string) => boolean {
    const verdicts = new Map<string, boolean>([[requiredKind, true]]);
    return (entryKind: string): boolean => {
      const known = verdicts.get(entryKind);
      if (known !== undefined) return known;
      const verdict = this.extendsChainReaches(entryKind, requiredKind);
      verdicts.set(entryKind, verdict);
      return verdict;
    };
  }

  private extendsChainReaches(entryKind: string, requiredKind: string): boolean {
    let current: string | undefined = entryKind;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      if (current === requiredKind) return true;
      seen.add(current);
      const def = this.#host.resolveDefinition(current);
      if (typeof def?.extends !== "string") return false;
      const parent = this.#host.resolveDefinitionIn(def.extends, def.metadata.module);
      current = parent ? `${parent.metadata.module}.${parent.metadata.name}` : undefined;
    }
    return false;
  }

  /** First pointer that resolves to a live instance wins — the manifest-level
   *  transcription of a controller's own `a ?? b` derivation. */
  private resolveCorrelationHandle(pointers: readonly string[]): ResourceHandle | undefined {
    for (const pointer of pointers) {
      const handle = this.resolveKeyPointer(pointer);
      if (handle) return handle;
    }
    return undefined;
  }

  private resolveKeyPointer(pointer: string): ResourceHandle | undefined {
    const segments = pointer.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return undefined;
    let manifest: Record<string, unknown> | undefined = this.#host.manifest;
    let value: unknown;
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        // A pointer may traverse a `!ref` into the referenced resource's own
        // manifest: read field → resolve reference → read field. Purely
        // mechanical — no kind is named here.
        const name = this.referencedName(value);
        manifest = name ? this.#host.resolveLocalManifest(name) : undefined;
        if (!manifest) return undefined;
      }
      value = manifest[segments[i]!];
      if (value === undefined || value === null) return undefined;
    }
    return this.handleOfValue(value);
  }

  /**
   * The LOCAL name a reference value points at, in any of its three shapes.
   *
   * A cross-module `!ref Alias.name` yields undefined: it names an instance in
   * another module's scope, and this resolver is scope-local, so taking the
   * bare name would bind to whatever local resource happened to share it.
   * Leaving it uncorrelated is the under-approximating direction. The analyzer's
   * `refName` holds the identical rule, so the two halves agree about what a
   * traversing pointer means.
   */
  private referencedName(value: unknown): string | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const id = getRefIdentity(value as object) ?? handleOfInstance(value as object)?.ref;
    if (id) return id.name;
    if (isRefSentinel(value)) {
      const source = value.source;
      const dot = source.indexOf(".");
      if (dot <= 0) return source;
      return source.slice(0, dot) === "Self" ? source.slice(dot + 1) : undefined;
    }
    const v = value as Record<string, unknown>;
    const pure =
      typeof v.kind === "string" &&
      typeof v.name === "string" &&
      Object.keys(v).every((k) => k === "kind" || k === "name" || k === "alias");
    if (!pure) return undefined;
    if (typeof v.alias === "string" && v.alias !== "Self") return undefined;
    return v.name as string;
  }

  /** The handle a pointer's terminal value identifies: a live instance's own
   *  handle, or the handle of the instance a reference resolves to. */
  private handleOfValue(value: unknown): ResourceHandle | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const direct = handleOfInstance(value as object);
    if (direct) return direct;
    const name = this.referencedName(value);
    if (!name) return undefined;
    const instance = this.#host.resolveLocalInstance(name);
    return instance ? handleOfInstance(instance as object) : undefined;
  }
}
