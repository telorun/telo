import { RuntimeError } from "./types.js";
import type { ResourceInstance } from "./resource-instance.js";

/** Marker type for x-telo-ref fields. Carries the live instance type at the TypeScript level;
 *  at runtime this field holds a resolved reference — `{ __ref: true, kind, name }` — until
 *  Phase 5 injection replaces it. The `__ref` marker is what tells a reference from an inline
 *  declaration, which holds `kind` and may hold a `name` field of its own.
 *  T is a phantom type — any capability interface (Invocable, Runnable, …) or ResourceInstance.
 *
 *  `alias` is set only for cross-module references resolved from `!ref Alias.name` against an
 *  imported library's `exports.resources`. It names the import alias whose child context owns
 *  the target instance, so Phase 5 injection can resolve into that context rather than the
 *  referencing resource's own. Absent (or `"Self"`) means a local reference. */
export interface KindRef<T = ResourceInstance> {
  readonly __ref?: true;
  readonly kind: string;
  readonly name: string;
  readonly alias?: string;
  /** The `[<binding>.key|index]` indexes of a family member's reference, in
   *  written order; empty for a plain reference. Every producer of a resolved
   *  reference writes it. */
  readonly indexes?: readonly KindRefIndex[];
  readonly __type?: T;
}

/** One index of a family member's reference: the loop binding it reads and
 *  which of the binding's members. */
export interface KindRefIndex {
  readonly binding: string;
  readonly member: "key" | "index";
}

/** A reference to the resource `name` of `kind`, reached through the import `alias` when it
 *  names another module's exported instance — what a controller building a reference in code
 *  hands `ensureKindRef`, `resolveRef` or a step's `invoke`. A plain `{ kind, name }` object is
 *  an inline declaration of `kind`. */
export function kindRef<T = ResourceInstance>(kind: string, name: string, alias?: string): KindRef<T> {
  return alias === undefined
    ? { __ref: true, kind, name, indexes: [] }
    : { __ref: true, kind, name, alias, indexes: [] };
}

/** True when `value` is a resolved reference — a plain object carrying the `__ref` marker, a
 *  string `kind` and a string `name`. */
export function isKindRef(value: unknown): value is KindRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ref = value as { __ref?: unknown; kind?: unknown; name?: unknown };
  return ref.__ref === true && typeof ref.kind === "string" && typeof ref.name === "string";
}

/** The name and import alias a `!ref <name>` / `!ref <Alias>.<name>` sentinel names, read from
 *  the `!ref` engine's verdict the loader attaches (`parsed` / `refusal`); undefined for anything
 *  that is not a `!ref` sentinel. `Self.<name>` is a local name. A sentinel whose text is outside
 *  the grammar, names a family member (`stores[each.key]`), or carries no verdict is
 *  `ERR_REF_UNRESOLVED`, since no name it could be read as is the one the author wrote. */
export function refSentinelTarget(value: unknown): { name: string; alias?: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const sentinel = value as {
    __tagged?: unknown;
    engine?: unknown;
    source?: unknown;
    parsed?: { alias?: unknown; name?: unknown; indexes?: unknown };
    refusal?: { offset?: unknown };
  };
  if (sentinel.__tagged !== true || sentinel.engine !== "ref" || typeof sentinel.source !== "string") {
    return undefined;
  }
  const parsed = sentinel.parsed;
  if (
    !parsed ||
    typeof parsed.name !== "string" ||
    !Array.isArray(parsed.indexes) ||
    (parsed.alias !== undefined && typeof parsed.alias !== "string")
  ) {
    const offset = sentinel.refusal?.offset;
    throw new RuntimeError(
      "ERR_REF_UNRESOLVED",
      `'!ref ${sentinel.source}' is not a reference` +
        (typeof offset === "number" ? ` (inadmissible text at offset ${offset})` : "") +
        `: a reference is '<name>' or '<Alias>.<name>'.`,
    );
  }
  if (parsed.indexes.length > 0) {
    throw new RuntimeError(
      "ERR_REF_UNRESOLVED",
      `'!ref ${sentinel.source}' names a family member, which only a template's expansion resolves; ` +
        `it reached a reader unexpanded.`,
    );
  }
  const alias = parsed.alias as string | undefined;
  return alias === undefined || alias === "Self" ? { name: parsed.name } : { name: parsed.name, alias };
}

/** Marker type for x-telo-scope fields. Has no runtime value — used only as a discriminant
 *  for Injected<T> to transform the field to ScopeHandle. */
export interface ScopeRef {
  readonly __scope: true;
}

/** Gives a controller access to the resources initialized within a scope. */
export interface ScopeContext {
  /** Returns the initialized instance for the given name. With a non-`Self` `alias`,
   *  resolves a cross-module exported instance (`!ref Alias.name`) into the owning
   *  import's child context instead of the scope-local / outer resources.
   *  Throws synchronously if the name was not declared in the scope —
   *  this is always a programming error; all scope members are statically
   *  validated in Phase 3 before the kernel ever reaches runtime. */
  getInstance(name: string, alias?: string): ResourceInstance;
  /** `run()` a scope-local resource through the kernel's dispatch chokepoint, so
   *  it is traced, records that it started, and publishes its snapshot — a bare
   *  `getInstance(name).run()` does none of that. Throws if the name was not
   *  declared in the scope or the instance is not runnable. */
  run(name: string): Promise<void>;
  /** The CEL `resources` map as seen from inside this scope: the enclosing
   *  module's published resources with the scope-local ones layered on top
   *  (scope-local names win, matching {@link getInstance}'s resolution order).
   *  Rebuilt per `ScopeHandle.run()`, so two concurrent runs of the same
   *  sequence never observe each other's scoped resources. */
  readonly resources: Record<string, unknown>;
}

/** Returned by Phase 5 injection in place of an x-telo-scope manifest array.
 *  The controller calls run() to open the scope, execute work, and tear it down. */
export interface ScopeHandle {
  run<T>(fn: (scope: ScopeContext) => Promise<T>): Promise<T>;
}

/** Transforms the raw config shape into the controller's view:
 *  - KindRef<U>   → U        (live instance, injected by Phase 5)
 *  - KindRef<U>[] → U[]      (live instances, injected by Phase 5)
 *  - ScopeRef     → ScopeHandle
 *  - everything else is unchanged */
export type Injected<T> = {
  [K in keyof T]: T[K] extends KindRef<infer U>
    ? U
    : T[K] extends KindRef<infer U>[]
      ? U[]
      : NonNullable<T[K]> extends ScopeRef
        ? ScopeHandle | Exclude<T[K], ScopeRef>
        : T[K];
};

/** Returns a schema node that emits `x-telo-ref` for the reference reach and carries
 *  KindRef<T> as its TypeScript type. For TypeBox schemas use Type.Unsafe<KindRef<T>>(Ref(...)).
 *
 *  @param ref The slot's `x-telo-ref` constraint, e.g. "Sql.Connection" or "Telo.Invocable" */
export const Ref = <T = ResourceInstance>(ref: string): KindRef<T> =>
  ({ "x-telo-ref": ref } as unknown as KindRef<T>);

/** Returns a schema node that emits `x-telo-scope` for the reference reach and carries
 *  ScopeRef as its TypeScript type. For TypeBox schemas use Type.Unsafe<ScopeRef>(Scope(...)).
 *
 *  @param visibilityPath JSON Pointer(s) (RFC 6901) declaring where x-telo-ref slots within
 *                        this field can resolve to scoped resources. */
export const Scope = (visibilityPath: string | string[]): ScopeRef =>
  ({ "x-telo-scope": visibilityPath } as unknown as ScopeRef);
