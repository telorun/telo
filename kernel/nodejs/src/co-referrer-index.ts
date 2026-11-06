import {
  CoReferrerSearch,
  isResolvedReference,
  pointerSegments,
  type CoReferrerCall,
  type CoReferrerInstance,
  type DefResolver,
} from "@telorun/analyzer";
import { refSentinelTarget, type ResourceManifest } from "@telorun/sdk";
import { authoredDeclarationOf } from "./declaration-scope.js";
import type { EvaluationContext } from "./evaluation-context.js";
import { declarationOfInstance } from "./instance-declaration.js";
import type { ModuleContext } from "./module-context.js";
import { templateBodyOf } from "./template-body-contexts.js";

/** A module-scope declaration as the index holds it: the context it is
 *  registered in — where its references resolve — its name there, and its
 *  registered declaration. */
export interface IndexedDeclaration {
  readonly context: EvaluationContext;
  readonly name: string;
  readonly manifest: ResourceManifest;
}

/**
 * The application's module instances as the co-referrer definition reads them
 * (`co-referrers.ts` in the analyzer), built from the live contexts once the
 * application has initialized and again after each reconcile — never at a
 * caller's creation, so a library's caller and its importer's co-referrers form
 * no init-order edge, and a reconcile adding one reaches the next call.
 *
 * An instance is one module context: the root, each `isolated` import's own and
 * a `shared` library's one context, listed at its first reach. Its declarations
 * are those it registers, in the order its documents are read (the root's in
 * the load's order, since a reconcile re-registers what it rebuilt), followed by
 * the body entries of each template instance among them, in their order.
 */
export class CoReferrerIndex {
  private readonly search: CoReferrerSearch<IndexedDeclaration, ResourceManifest>;
  /** Every declaration the tree holds, in load order. */
  readonly declarations: readonly IndexedDeclaration[];
  private readonly held = new Set<ResourceManifest>();
  /** Set when the scope run an index belongs to has unwound. */
  withdrawn = false;

  /**
   * `extra` are module contexts the walk from `root` does not reach that the
   * tree still holds — a `shared` library first instantiated by a scoped
   * import, which the root owns — listed after the root's own imports;
   * `excluded` are those it reaches and does not hold.
   */
  constructor(
    root: ModuleContext,
    rootOrder: readonly ResourceManifest[],
    resolve: DefResolver,
    extra: readonly ModuleContext[] = [],
    /** Contexts the tree never holds — a `shared` library, the root's, in a
     *  scoped import's tree. */
    excluded: ReadonlySet<ModuleContext> = new Set(),
  ) {
    const rank = new Map(rootOrder.map((manifest, index) => [manifest, index]));
    const keys = new Map<EvaluationContext, CoReferrerInstance<IndexedDeclaration>>();
    const declarationsOf = (context: EvaluationContext, ordered: boolean): IndexedDeclaration[] => {
      let own = context.ownDeclarations();
      if (ordered) {
        own = own
          .map((entry, index) => ({ entry, index }))
          .sort(
            (a, b) =>
              (rank.get(a.entry[1]) ?? Number.MAX_SAFE_INTEGER) -
                (rank.get(b.entry[1]) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
          )
          .map(({ entry }) => entry);
      }
      const out: IndexedDeclaration[] = own.map(([name, manifest]) => ({ context, name, manifest }));
      for (const [name] of own) {
        const body = templateBodyOf(context.resourceInstances.get(name)?.instance);
        if (body) out.push(...declarationsOf(body as unknown as EvaluationContext, false));
      }
      return out;
    };
    const instanceOf = (context: ModuleContext, isRoot: boolean): CoReferrerInstance<IndexedDeclaration> => {
      const known = keys.get(context);
      if (known) return known;
      const imports: CoReferrerInstance<IndexedDeclaration>[] = [];
      const instance = { key: String(keys.size), declarations: declarationsOf(context, isRoot), imports };
      keys.set(context, instance);
      for (const [name, manifest] of context.ownDeclarations()) {
        if (manifest.kind !== "Telo.Import") continue;
        const library = context.importedLibrary(name);
        if (library && !excluded.has(library)) imports.push(instanceOf(library, false));
      }
      return instance;
    };
    const rootInstance = instanceOf(root, true);
    for (const context of extra) {
      if (!keys.has(context)) (rootInstance.imports as CoReferrerInstance<IndexedDeclaration>[]).push(instanceOf(context, false));
    }
    const declarations: IndexedDeclaration[] = [];
    const seen = new Set<CoReferrerInstance<IndexedDeclaration>>();
    const collect = (instance: CoReferrerInstance<IndexedDeclaration>): void => {
      if (seen.has(instance)) return;
      seen.add(instance);
      declarations.push(...instance.declarations);
      for (const imported of instance.imports) collect(imported);
    };
    collect(rootInstance);
    this.declarations = declarations;
    for (const d of declarations) this.held.add(authoredDeclarationOf(d.manifest) ?? d.manifest);
    const segmentsOf = new Map<string, readonly string[]>();
    this.search = new CoReferrerSearch(
      rootInstance,
      {
        kindOf: (d) => d.context.kindResolver?.(d.manifest.kind as string) ?? (d.manifest.kind as string),
        targetAt: (d, call) => {
          let segments = segmentsOf.get(call.slot);
          if (!segments) segmentsOf.set(call.slot, (segments = pointerSegments(call.slot) ?? []));
          return declarationNamedBy(valueAt(d.manifest, segments), d.context);
        },
      },
      resolve,
    );
  }

  /** Whether `target` — a registered declaration — is one this tree holds. */
  holds(target: ResourceManifest): boolean {
    return this.held.has(target);
  }

  /** The declaration a reference slot of `d` at `call.slot` names. */
  targetOf(d: IndexedDeclaration, call: CoReferrerCall): ResourceManifest | undefined {
    return declarationNamedBy(valueAt(d.manifest, pointerSegments(call.slot) ?? []), d.context);
  }

  /** The co-referrers of `target` — a registered declaration — under `call`,
   *  in load order. */
  coReferrersOf(call: CoReferrerCall, target: ResourceManifest): readonly IndexedDeclaration[] {
    return this.search.of(call, target);
  }
}

/** The registered declaration a reference slot's value names, resolved in the
 *  context the value was written in — a reference by its name, a live instance
 *  (a slot Phase-5 injection substituted) by the declaration it was created
 *  from — or undefined when the value names none. */
export function declarationNamedBy(
  value: unknown,
  context: { resolveDeclaredManifest?(name: string, alias?: string): ResourceManifest | undefined },
): ResourceManifest | undefined {
  const ref = isResolvedReference(value) ? value : refSentinelTarget(value);
  if (ref) {
    const declared = context.resolveDeclaredManifest?.(ref.name, ref.alias);
    return declared ? (authoredDeclarationOf(declared) ?? declared) : undefined;
  }
  const declared = declarationOfInstance(value);
  return declared ? (authoredDeclarationOf(declared) ?? declared) : undefined;
}

function valueAt(manifest: ResourceManifest, keys: readonly string[]): unknown {
  let value: unknown = manifest;
  for (const key of keys) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}
