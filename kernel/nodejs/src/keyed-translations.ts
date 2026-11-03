/**
 * **Keyed translations at runtime** — a library's own texts, declared by key in a
 * `Telo.KeyedTranslations` document and translated by resources of the kind it
 * declares. The readers and every judgement are the analyzer's
 * (`keyed-translations.ts`, `text-keys.ts`); this file refuses what they find
 * where the kernel creates a resource, and finds the keyed set a kind translates.
 * Layering lives in the application's translation set.
 */
import {
  isKeyedTranslationsDoc,
  judgeKeyedCatalog,
  judgeKeyedDeclaration,
  keyedTranslationsOf,
  misplacedTextKeys,
  renderValuePath,
} from "@telorun/analyzer";
import { isCompiledValue, RuntimeError, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";

/** Resolves a kind in the scope of the module that wrote it. */
export type KindResolver = (kind: string, module: string | undefined) => ResourceDefinition | undefined;

export const canonicalKindOf = (definition: ResourceDefinition): string =>
  `${definition.metadata.module}.${definition.metadata.name}`;

/** The keyed set's definition `definition` translates — itself, or the nearest
 *  along `extends` — or undefined for a kind translating no keyed set. */
export function keyedSetOf(
  definition: ResourceDefinition | undefined,
  resolve: KindResolver,
): ResourceDefinition | undefined {
  const seen = new Set<object>();
  let at = definition;
  while (at && !seen.has(at)) {
    if (keyedTranslationsOf(at)) return at;
    seen.add(at);
    at = typeof at.extends === "string" ? resolve(at.extends, at.metadata.module) : undefined;
  }
  return undefined;
}

/**
 * A keyed declaration judged in its module's language (`lang`, `null` for none),
 * and a resource of a keyed kind (`translates`) judged against its own `lang`,
 * before its expressions are expanded: the first problem is refused as
 * `ERR_<code>`, worded as `telo check` words it.
 */
export function refuseKeyedTexts(
  resource: ResourceManifest,
  label: string,
  lang: string | null,
  translates: boolean,
): void {
  const declaration = isKeyedTranslationsDoc(resource);
  if (!declaration && !translates) return;
  const { kind, metadata, ...catalog } = resource;
  const [problem] = declaration
    ? judgeKeyedDeclaration(resource, lang, isCompiledValue)
    : judgeKeyedCatalog(catalog, isCompiledValue);
  if (!problem) return;
  const what = declaration ? "the keyed text" : "the translation";
  throw new RuntimeError(
    `ERR_${problem.code}`,
    `${label}: ${what} at '${renderValuePath(problem.path)}' is refused: ${problem.message}.`,
  );
}

/** An `x-telo-text-keys` the resource writes outside a kind's `schema:` root,
 *  refused as `telo check` words it; a kind's `schema:` is judged when the kind
 *  registers. */
export function refuseMisplacedTextKeys(resource: ResourceManifest): void {
  const [problem] = misplacedTextKeys(resource as unknown as Record<string, unknown>);
  if (problem) throw new RuntimeError("ERR_TEXT_KEYS_INVALID", `${resource.kind} ${problem.message}`);
}
