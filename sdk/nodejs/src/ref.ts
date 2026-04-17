import type { ResourceInstance } from "./resource-instance.js";

/** Marker type for x-telo-ref fields. Carries the live instance type at the TypeScript level;
 *  at runtime this field holds `{ kind, name }` until Phase 5 injection replaces it.
 *  T is a phantom type — any capability interface (Invocable, Runnable, …) or ResourceInstance. */
export interface KindRef<T = ResourceInstance> {
  readonly kind: string;
  readonly name: string;
  readonly __type?: T;
}

/** Marker type for x-telo-scope fields. Has no runtime value — used only as a discriminant
 *  for Injected<T> to transform the field to ScopeHandle. */
export interface ScopeRef {
  readonly __scope: true;
}

/** Gives a controller access to the resources initialized within a scope. */
export interface ScopeContext {
  /** Returns the initialized instance for the given name.
   *  Throws synchronously if the name was not declared in the scope —
   *  this is always a programming error; all scope members are statically
   *  validated in Phase 3 before the kernel ever reaches runtime. */
  getInstance(name: string): ResourceInstance;
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

/** Returns a schema node that emits `x-telo-ref` for buildReferenceFieldMap and carries
 *  KindRef<T> as its TypeScript type. For TypeBox schemas use Type.Unsafe<KindRef<T>>(Ref(...)).
 *
 *  @param ref Canonical ref string: "namespace/module-name#TypeName" or "telo#TypeName" */
export const Ref = <T = ResourceInstance>(ref: string): KindRef<T> =>
  ({ "x-telo-ref": ref } as unknown as KindRef<T>);

/** Returns a schema node that emits `x-telo-scope` for buildReferenceFieldMap and carries
 *  ScopeRef as its TypeScript type. For TypeBox schemas use Type.Unsafe<ScopeRef>(Scope(...)).
 *
 *  @param visibilityPath JSON Pointer(s) (RFC 6901) declaring where x-telo-ref slots within
 *                        this field can resolve to scoped resources. */
export const Scope = (visibilityPath: string | string[]): ScopeRef =>
  ({ "x-telo-scope": visibilityPath } as unknown as ScopeRef);
