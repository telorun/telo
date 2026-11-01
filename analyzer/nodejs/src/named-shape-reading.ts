/**
 * A declaration as a read ACROSS A REFERENCE sees it: a named shape with its
 * `extends` parents folded into its `schema` — the shape it IS, by the fold the
 * kernel's type controller registers it with — and every other declaration as
 * written. A rule's `resolve:` and a template forward crossing a reference read
 * through it, on both halves, so `self.model.schema` and `this.model.schema`
 * hold the inherited properties wherever they are read, whether or not the shape
 * has been created.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { DeclarationRequests } from "./declaration-requests.js";
import { isTypeKind, resolveTypeFieldToSchema } from "./validate-cel-context.js";

/** The reading over `requests`, the declarations a parent resolves against.
 *  A declaration with nothing to fold is returned by identity; a folded one is
 *  built once per declaration. */
export function namedShapeReading(
  requests: DeclarationRequests,
): <T extends ResourceManifest | Record<string, any>>(declaration: T) => T {
  const folded = new WeakMap<object, object>();
  return <T extends ResourceManifest | Record<string, any>>(declaration: T): T => {
    const shape = declaration as { kind?: unknown; schema?: unknown; extends?: unknown };
    if (!shape.extends || !isTypeKind(shape.kind, requests)) return declaration;
    let view = folded.get(declaration);
    if (!view) {
      const schema = resolveTypeFieldToSchema(
        { schema: shape.schema, extends: shape.extends },
        requests,
        declaration as Record<string, any>,
      );
      view = schema ? { ...declaration, schema } : declaration;
      folded.set(declaration, view);
    }
    return view as T;
  };
}
