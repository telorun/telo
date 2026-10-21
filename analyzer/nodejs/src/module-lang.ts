/**
 * A module's `lang:` — the language its own texts are written in, read off its
 * `Telo.Application` / `Telo.Library` document. One reader for both halves: the
 * analyzer judges a module's plural sources against it, the kernel attributes the
 * `Text` records it builds with it.
 *
 * Absent, the module writes in `und`, whose only plural category is `other` — and a
 * plural source there is `MESSAGE_SOURCE_LANGUAGE_MISSING` rather than a category
 * refusal, so this reader answers `null` rather than `und`. The tag's spelling is
 * the `language-tag` format's, which schema validation reports. Browser-safe.
 */
import { isModuleKind } from "./module-kinds.js";
import { UNDETERMINED_LANGUAGE } from "./text-slot.js";

/** The `lang:` a module document declares, or `null`. */
export function moduleLangOf(moduleDoc: unknown): string | null {
  if (!moduleDoc || typeof moduleDoc !== "object") return null;
  const lang = (moduleDoc as { lang?: unknown }).lang;
  return typeof lang === "string" && lang !== "" ? lang : null;
}

/** The language a `Text` record names for a module: its `lang:`, else `und`. */
export function recordLangOf(lang: string | null): string {
  return lang ?? UNDETERMINED_LANGUAGE;
}

/** Every module document's `lang:` among `manifests`, by module name. */
export function moduleLangs(manifests: readonly unknown[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const manifest of manifests) {
    const doc = manifest as { kind?: string; metadata?: { name?: unknown } } | undefined;
    if (!doc || !isModuleKind(doc.kind)) continue;
    const name = doc.metadata?.name;
    if (typeof name === "string") out.set(name, moduleLangOf(doc));
  }
  return out;
}
