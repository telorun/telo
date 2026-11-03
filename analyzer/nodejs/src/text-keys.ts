import type { ResourceDefinition } from "@telorun/sdk";
import { keyedTranslationsOf } from "./keyed-translations.js";
import { renderValuePath, type ValuePath } from "./text-slot.js";

/**
 * `x-telo-text-keys: [<Alias>.<Kind>, …]` — THE single reader of the keyed sets
 * a kind's resources show, for `telo check` and the kernel alike.
 *
 * Written on a kind's schema ROOT, each entry names a kind a
 * `Telo.KeyedTranslations` document declares, alias-qualified and canonicalized
 * in the declaring module's scope beside `x-telo-ref` (`resolveSchemaRefKinds`),
 * so what a resource shows is found by reference, never by a kind's name. A
 * kind naming none shows the sets of the nearest along `extends` naming any
 * (`textKeysDeclarer`, `extends-resolution.ts`), read in that definition's
 * module; the annotation is never merged into a child's schema. Misplaced,
 * malformed, or naming no keyed kind, it is `TEXT_KEYS_INVALID`
 * (`ERR_TEXT_KEYS_INVALID` when the kernel registers the kind or creates the
 * resource writing it).
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const TEXT_KEYS_ANNOTATION = "x-telo-text-keys";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The keyed kinds a kind's schema root names, as written in its declaring
 *  module (canonical in an analysis once `resolveSchemaRefKinds` rewrote them);
 *  empty when it names none. */
export function textKeysOf(schema: unknown): string[] {
  const declared = isPlainObject(schema) ? schema[TEXT_KEYS_ANNOTATION] : undefined;
  return Array.isArray(declared) ? declared.filter((kind): kind is string => typeof kind === "string") : [];
}

/** Rewrite each kind `node`'s annotation names, in place: `rewrite` returns the
 *  canonical kind, or undefined to leave the authored one. */
export function rewriteTextKeysKinds(
  node: Record<string, unknown>,
  rewrite: (kind: string) => string | undefined,
): void {
  const declared = node[TEXT_KEYS_ANNOTATION];
  if (!Array.isArray(declared)) return;
  node[TEXT_KEYS_ANNOTATION] = declared.map((kind) => (typeof kind === "string" ? (rewrite(kind) ?? kind) : kind));
}

/** True when `node` writes the annotation. */
export function hasTextKeys(node: Record<string, unknown>): boolean {
  return Object.hasOwn(node, TEXT_KEYS_ANNOTATION);
}

export interface TextKeysProblem {
  /** Where the annotation is written, from the kind document. */
  readonly path: string;
  readonly message: string;
}

/**
 * Every misplaced or malformed `x-telo-text-keys` of a kind: one below its
 * schema's root, a root value that is no list of kind names, and an entry naming
 * no kind a `Telo.KeyedTranslations` document declares. `resolve` answers a
 * canonical kind.
 */
export function textKeysProblems(
  kind: string,
  schema: unknown,
  resolve: (kind: string) => ResourceDefinition | undefined,
  at: ValuePath = ["schema"],
): TextKeysProblem[] {
  if (!isPlainObject(schema)) return [];
  const problems: TextKeysProblem[] = [];
  const report = (path: ValuePath, reason: string) =>
    problems.push({ path: renderValuePath(path), message: `'${kind}' declares '${renderValuePath(path)}' ${reason}` });

  if (hasTextKeys(schema)) {
    const declared = schema[TEXT_KEYS_ANNOTATION];
    const path = [...at, TEXT_KEYS_ANNOTATION];
    if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string")) {
      report(path, "as something other than a list of alias-qualified kinds (`[<Alias>.Translations]`).");
    } else {
      declared.forEach((entry: string, index) => {
        const definition = resolve(entry);
        if (!definition) {
          report([...path, index], `naming '${entry}', which names no kind. Write '<Alias>.<Kind>' for a kind a 'Telo.KeyedTranslations' document declares, the alias one of this file's imports or 'Self'.`);
        } else if (!keyedTranslationsOf(definition)) {
          report([...path, index], `naming '${entry}', which translates no keyed set: name a kind a 'Telo.KeyedTranslations' document declares.`);
        }
      });
    }
  }

  const seen = new Set<object>();
  const visit = (node: unknown, path: ValuePath, root: boolean): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index], false));
      return;
    }
    const record = node as Record<string, unknown>;
    if (!root && hasTextKeys(record)) {
      report([...path, TEXT_KEYS_ANNOTATION], "below the schema's root: the keyed sets a kind's resources show are named once, on the root of its schema.");
    }
    for (const [key, child] of Object.entries(record)) {
      if (root && key === TEXT_KEYS_ANNOTATION) continue;
      visit(child, [...path, key], false);
    }
  };
  visit(schema, at, true);
  return problems;
}

const KIND_DOCUMENTS = new Set(["Telo.Definition", "Telo.Abstract"]);

const isKindDocument = (value: Record<string, unknown>): boolean =>
  typeof value.kind === "string" && KIND_DOCUMENTS.has(value.kind);

const isPlainContainer = (value: unknown): value is object => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Every `x-telo-text-keys` a document writes outside a kind's `schema:` — in
 * `status:`, a contract, a callable's parameters or result, a template body, a
 * named shape, any resource's configuration — where nothing reads it. A kind
 * document's own `schema:` is {@link textKeysProblems}'; a kind document nested
 * in another (a `with:` member) is judged as its own document, not walked here.
 */
export function misplacedTextKeys(document: Record<string, unknown>): TextKeysProblem[] {
  const name = String((document.metadata as { name?: unknown } | undefined)?.name);
  const problems: TextKeysProblem[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, path: ValuePath): void => {
    if (!isPlainContainer(node) || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    const record = node as Record<string, unknown>;
    if (path.length > 0 && isKindDocument(record)) return;
    if (path.length > 0 && hasTextKeys(record)) {
      const at = renderValuePath([...path, TEXT_KEYS_ANNOTATION]);
      problems.push({
        path: at,
        message:
          `'${name}' declares '${at}' where nothing reads it: the keyed sets a kind's resources ` +
          `show are named once, on the root of the kind's schema.`,
      });
    }
    for (const [key, child] of Object.entries(record)) {
      if (path.length === 0 && key === "schema" && isKindDocument(record)) continue;
      visit(child, [...path, key]);
    }
  };
  visit(document, []);
  return problems;
}
