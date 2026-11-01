import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isResolvedReference, type ResolvedReference } from "@telorun/analyzer";
import { declarationScopeOf } from "../../declaration-scope.js";
import { instanceDeclaration } from "../../instance-declaration.js";

/** Where a name a reference holds is resolved. */
export interface WrittenScope {
  resolveDeclaredManifest?(name: string, alias?: string): ResourceManifest | undefined;
}

/**
 * The declaration a reference names, resolved in the scope of the declaration
 * that WROTE it — `writer`, when the kernel recorded where it was declared, else
 * `fallback` (the instance's own context, for a reference its own manifest
 * holds). A reference read past another reference is its writer's, never the
 * reader's: a library's `!ref users` means the library's `users`.
 */
export function crossedDeclaration(
  reference: ResolvedReference,
  writer: unknown,
  fallback: WrittenScope,
): ResourceManifest | undefined {
  const scope = declarationScopeOf(writer) ?? fallback;
  return scope.resolveDeclaredManifest?.(reference.name, reference.alias);
}

/** Plain data a key is read off: a mapping as written, never an instance, a
 *  list or an expression. */
export function isPlainMapping(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isCompiledValue(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The value a bare forward names — `self.<path>`, or a repeat binding's
 * `<binding>.value.<path>` from where the consumer wrote the element — read off
 * declarations only, never a member of a live instance. Each key is read off
 * the plain data in hand (a list by index); past a live instance, off its
 * OUTERMOST declaration; past a reference left as written (a declaration read,
 * never injected), off the declaration it names, resolved in the scope of the
 * declaration that wrote it — `writer` for the root's own references, else
 * `instanceScope`. Either declaration is read as `telo check` reads it past a
 * reference — a named shape with its `extends` folded (`readDeclaration`) — and
 * holds a live instance at each slot the kernel injected, handed on as it is.
 */
export function forwardedValue(
  root: unknown,
  keys: readonly (string | number)[],
  instanceScope: WrittenScope,
  readDeclaration: (declaration: ResourceManifest) => ResourceManifest,
  writer?: unknown,
): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    let data = cur;
    if (isResolvedReference(cur)) {
      const declaration = crossedDeclaration(cur, writer, instanceScope);
      if (!declaration) return undefined;
      writer = declaration;
      data = readDeclaration(declaration);
    } else {
      const declaration = instanceDeclaration(cur);
      if (declaration) {
        writer = declaration;
        data = readDeclaration(declaration);
      }
    }
    if (Array.isArray(data)) cur = typeof key === "number" && Number.isInteger(key) ? data[key] : undefined;
    else cur = isPlainMapping(data) && Object.hasOwn(data, key) ? data[key] : undefined;
  }
  return cur;
}
