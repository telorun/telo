import type { ResourceDefinition } from "@telorun/sdk";
import { kindIsA } from "./co-referrer-slot.js";
import { effectiveAuthorSchema, type DefResolver } from "./extends-resolution.js";
import { declaredReach } from "./reference-reach.js";
import type { CoReferrerCall } from "./ref-slot.js";
import { pointerToPath } from "./resource-rule.js";

/**
 * THE CO-REFERRERS of a reference slot declaring `callsCoReferrers: { kind,
 * slot }` — the one definition the analyzer's call-graph edges and the kernel's
 * dispatch-time set are both computed from.
 *
 * A co-referrer of the slot's target is every MODULE-SCOPE declaration whose
 * kind is `kind` or extends it and whose reference slot at `slot` names that
 * same target — the target being a declaration of one module instance, so two
 * `isolated` imports of a library have two targets and one `shared` import has
 * one. They are listed in application load order: the root instance, then its
 * imports depth-first in `imports:` order, each instance once, at its first
 * reach; within an instance, in the order its documents are read.
 *
 * Generic over what a declaration and a target are, so the analyzer reads call
 * graph nodes and the kernel reads its module contexts' declarations; which
 * declarations are at module scope is the caller's (a scope member is never
 * one — {@link scopedCoReferrerCalls}).
 *
 * Browser-safe.
 */

/** One module instance, as the load-order rule reads it. */
export interface CoReferrerInstance<D> {
  /** Identity of the instance: a library reached twice under one key is one
   *  instance (`shared`), listed at its first reach. */
  readonly key: string;
  /** Its module-scope declarations, in the order its documents are read. */
  readonly declarations: readonly D[];
  /** The instances its `imports:` reach, in `imports:` order. */
  readonly imports: readonly CoReferrerInstance<D>[];
}

/** How the definition reads a declaration. */
export interface CoReferrerReading<D, T> {
  /** The declaration's canonical `<module>.<Kind>`, or undefined. */
  kindOf(declaration: D): string | undefined;
  /** What the declaration's reference at the slot `call.slot` points at names,
   *  or undefined when it holds none there. Compared by identity with the
   *  target. */
  targetAt(declaration: D, call: CoReferrerCall): T | undefined;
}

/** Every module instance of the tree under `root`, in load order. */
export function instancesInLoadOrder<D>(root: CoReferrerInstance<D>): CoReferrerInstance<D>[] {
  const out: CoReferrerInstance<D>[] = [];
  const seen = new Set<string>();
  const visit = (instance: CoReferrerInstance<D>): void => {
    if (seen.has(instance.key)) return;
    seen.add(instance.key);
    out.push(instance);
    for (const imported of instance.imports) visit(imported);
  };
  visit(root);
  return out;
}

/**
 * The co-referrers of the instance tree under `root`: every declaration read
 * once, in load order, with its kind; per call, the declarations of a kind that
 * is or extends the call's kind grouped by the target they name, so each target
 * is answered once. `resolve` maps a canonical kind to its definition.
 */
export class CoReferrerSearch<D, T> {
  private readonly declarations: ReadonlyArray<{ readonly declaration: D; readonly kind: string }>;
  private readonly byCall = new Map<string, Map<T, D[]>>();

  constructor(
    root: CoReferrerInstance<D>,
    private readonly reading: CoReferrerReading<D, T>,
    private readonly resolve: DefResolver,
  ) {
    const declarations: Array<{ declaration: D; kind: string }> = [];
    for (const instance of instancesInLoadOrder(root)) {
      for (const declaration of instance.declarations) {
        const kind = reading.kindOf(declaration);
        if (kind !== undefined) declarations.push({ declaration, kind });
      }
    }
    this.declarations = declarations;
  }

  /** The co-referrers of `target` under `call`, in load order. */
  of(call: CoReferrerCall, target: T): readonly D[] {
    const key = `${call.kind}\0${call.slot}`;
    let byTarget = this.byCall.get(key);
    if (!byTarget) {
      byTarget = new Map();
      const isA = new Map<string, boolean>();
      for (const { declaration, kind } of this.declarations) {
        let matches = isA.get(kind);
        if (matches === undefined) isA.set(kind, (matches = kindIsA(kind, call.kind, this.resolve)));
        if (!matches) continue;
        const named = this.reading.targetAt(declaration, call);
        if (named === undefined) continue;
        const list = byTarget.get(named);
        if (list) list.push(declaration);
        else byTarget.set(named, [declaration]);
      }
      this.byCall.set(key, byTarget);
    }
    return byTarget.get(target) ?? [];
  }
}

/**
 * Every `callsCoReferrers` the kinds of `definitions` declare, read off their
 * merged author schemas — what makes a declaration a co-referrer wherever it
 * is declared, so a scope member of a co-referrer kind is refused whether or
 * not anything calling it is in view.
 */
export function registeredCoReferrerCalls(
  definitions: Iterable<ResourceDefinition>,
  resolve: DefResolver,
): CoReferrerCall[] {
  const out: CoReferrerCall[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const schema = effectiveAuthorSchema(definition, resolve);
    for (const reference of declaredReach(schema).references) {
      for (const entry of reference.entries) {
        const call = entry.callsCoReferrers;
        if (!call) continue;
        const key = `${call.kind}\0${call.slot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(call);
      }
    }
  }
  return out;
}

/**
 * The calls under which a declaration of `kind` holding references at `paths`
 * would be a co-referrer — refused for a scope member (`CO_REFERRER_SCOPED`),
 * which exists only while its scope runs, so no dispatch from module scope can
 * reach it.
 */
export function scopedCoReferrerCalls(
  kind: string,
  paths: ReadonlySet<string>,
  calls: readonly CoReferrerCall[],
  resolve: DefResolver,
): CoReferrerCall[] {
  return calls.filter((call) => paths.has(pointerToPath(call.slot)) && kindIsA(kind, call.kind, resolve));
}

/** The message of `CO_REFERRER_SCOPED`, shared by `telo check` and the kernel. */
export function coReferrerScopedMessage(args: {
  kind: string;
  name: string;
  /** The target the reference at the slot names, as written. */
  target: string;
  slot: string;
  /** The scope field as written (`with`). */
  scope: string;
  owner: string;
  /** Set for a co-referrer in the library a scoped `Telo.Import` reaches: the
   *  member's name. Its target lives longer than that library instance. */
  through?: string;
}): string {
  const head =
    `${args.kind} '${args.name}' names ${args.target} at '${args.slot}', which makes it a ` +
    `co-referrer that every dispatch through a 'callsCoReferrers' slot naming ${args.target} ` +
    `calls, but it is declared in `;
  return args.through === undefined
    ? head +
        `the \`${args.scope}:\` scope of '${args.owner}', so it exists only while that scope runs ` +
        `and no such dispatch can reach it; declare it at module scope.`
    : head +
        `the library imported as '${args.through}' in the \`${args.scope}:\` scope of '${args.owner}', ` +
        `which exists only while that scope runs, while ${args.target} outlives it; declare the ` +
        `handler in a module that lives as long as ${args.target}.`;
}
