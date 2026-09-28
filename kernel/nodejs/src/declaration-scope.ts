import type { EvaluationContext, ResourceManifest } from "@telorun/sdk";

/**
 * Declaration → the context that DECLARED it, and the form its author wrote.
 *
 * A projected contract (`x-telo-schema-projection-from`) whose pointer crosses a
 * reference continues inside the declaration that reference names, and every
 * reference met there is written in the scope of the module that declared THAT
 * declaration — a library's `node` naming `!ref users` means the library's
 * `users`, whoever projects through it. The binding resource's own context is
 * right only for the first hop, so each declaration carries the context it was
 * registered in: the `instance-declaration.ts` precedent, one direction further.
 *
 * The authored form rides along because the kernel hands a contract the
 * EXPANDED declaration, where a compile-time expression has already become a
 * value — and a selector landing on an expression is refused whether or not it
 * has been evaluated, as it is by `telo check`.
 *
 * Weak and one-way: a declaration yields a lookup scope, never an instance.
 */
export type DeclarationScope = Pick<EvaluationContext, "resolveDeclaredManifest" | "kindResolver">;

interface DeclarationRecord {
  readonly scope: DeclarationScope;
  readonly authored: ResourceManifest;
}

const records = new WeakMap<object, DeclarationRecord>();

/** Record where `declaration` was declared. First record wins: registration
 *  records the manifest, creation its expanded copy, and neither moves it. */
export function recordDeclarationScope(
  declaration: ResourceManifest,
  scope: DeclarationScope,
  authored: ResourceManifest = declaration,
): void {
  if (!records.has(declaration)) records.set(declaration, { scope, authored });
}

/** The context `declaration` was declared in, if it is one of ours. */
export function declarationScopeOf(declaration: unknown): DeclarationScope | undefined {
  return declaration && typeof declaration === "object"
    ? records.get(declaration as object)?.scope
    : undefined;
}

/** `declaration` as its author wrote it, if it is one of ours. */
export function authoredDeclarationOf(declaration: unknown): ResourceManifest | undefined {
  return declaration && typeof declaration === "object"
    ? records.get(declaration as object)?.authored
    : undefined;
}
