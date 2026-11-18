/**
 * The loader's and the analyzer's stamps on a document's `metadata`, and the
 * refusal of one an author wrote.
 *
 * Every key here is written onto `metadata` after the document is read — its
 * file and line, the module it belongs to, an import's resolved identity, a
 * forwarded document's marks. Each is read as a fact about the document, so one
 * written by hand would forge it: an authored `metadata.module` files a
 * definition under another module, and `telo check` reports nothing for it. The
 * loader refuses each where it reads authored text, before anything is stamped
 * (`METADATA_RESERVED_FIELD`, `metadata-stamp-refusals.ts`; `ERR_METADATA_RESERVED_FIELD`
 * at load). The list is data (`metadata-stamps.json`), which the Rust loader
 * reads too.
 *
 * A NESTED declaration — inline at a reference slot, a scope member, a template
 * body entry — is stamped by whatever makes it a declaration, from its holder:
 * an authored stamp is dropped there ({@link writtenNestedStamps}), and refused
 * as written, in every option of every choice (`writtenNestedStampPlaces`).
 */
import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel } from "@telorun/templating";
import { STAND_IN_MARK } from "./choice-expansion.js";
import STAMPS from "./metadata-stamps.json" with { type: "json" };

export const METADATA_RESERVED_FIELD = "METADATA_RESERVED_FIELD";

const HOLDS: ReadonlyMap<string, string> = new Map(STAMPS.map((s) => [s.field, s.holds]));

/** Every key the loader or the analyzer stamps onto `metadata`. */
export const METADATA_STAMPS: ReadonlySet<string> = new Set(HOLDS.keys());

/** The stamp keys a document's `metadata` holds, in written order. */
export function writtenMetadataStamps(manifest: unknown): string[] {
  const metadata = (manifest as { metadata?: unknown } | null | undefined)?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.keys(metadata).filter((key) => METADATA_STAMPS.has(key));
}

/** The marks the choice expansion writes on a nested declaration it chooses. */
const CHOICE_MARKS: ReadonlySet<string> = new Set(["xTeloChoice", STAND_IN_MARK]);

/** The stamp keys a nested declaration's `metadata` holds as it reaches the step
 *  that makes it a declaration — every stamp but the marks of the choice that
 *  chose it. */
export function writtenNestedStamps(declaration: unknown): string[] {
  return writtenMetadataStamps(declaration).filter((key) => !CHOICE_MARKS.has(key));
}

/** `metadata` without `fields`. */
export function withoutStamps(metadata: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !fields.includes(key)));
}

/** The label a stamp's refusal opens with: the declaration's kind — or the tag
 *  it is declared behind — and its name. */
export function stampLabel(manifest: { kind?: unknown; metadata?: unknown }): string {
  const name = (manifest.metadata as { name?: unknown } | undefined)?.name;
  const kind = typeof manifest.kind === "string" ? manifest.kind : (expansionTagLabel(manifest) ?? "resource");
  return `${kind}${typeof name === "string" ? `/${name}` : ""}`;
}

/** Why the stamp `field`, written at `place` of the declaration `label` names, is
 *  refused. */
export function writtenStampMessage(label: string, place: string, field: string): string {
  return (
    `${label}: '${place}' is written by the loader — ${HOLDS.get(field)} — ` +
    `and cannot be written in a manifest. Remove it.`
  );
}

/** Why a stamp written on a document's own `metadata` is refused. */
export function metadataStampMessage(manifest: { kind?: unknown; metadata?: unknown }, field: string): string {
  return writtenStampMessage(stampLabel(manifest), `metadata.${field}`, field);
}

/** Where an authored stamp on a nested declaration is written: the top-level
 *  document holding it, the stamp's path there, and the declaration its refusal
 *  is labelled by — the nearest enclosing one whose name the author wrote. */
export interface WrittenStampPlace {
  root: ResourceManifest;
  /** `resources[0].metadata.module`. */
  path: string;
  field: string;
  /** The labelling declaration's `<kind>/<name>`. */
  label: string;
  /** The labelling declaration's place in `root` (`""` for `root` itself). */
  labelAt: string;
}

/** Each stamp an author wrote on a `resources:` entry of the template body of
 *  `definition` as written, the declaration-position tag of a family or a choice
 *  included. */
export function bodyEntryStamps(definition: ResourceManifest): WrittenStampPlace[] {
  const body = (definition as { resources?: unknown }).resources;
  if (!Array.isArray(body)) return [];
  const out: WrittenStampPlace[] = [];
  body.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    for (const field of writtenMetadataStamps(entry)) {
      out.push({
        root: definition,
        path: `resources[${index}].metadata.${field}`,
        field,
        label: stampLabel(entry as { kind?: unknown; metadata?: unknown }),
        labelAt: `resources[${index}]`,
      });
    }
  });
  return out;
}

/** Whether a declaration nested anywhere in `manifest` may hold a stamp its
 *  author wrote — what makes judging it worth reading its options. A scoped
 *  `Telo.Import` carries the loader's, and is the loader's to judge. */
export function holdsNestedStamp(manifest: ResourceManifest): boolean {
  const walk = (value: unknown, nested: boolean): boolean => {
    if (!value || typeof value !== "object") return false;
    if ((value as { __compiled?: unknown }).__compiled) return false;
    if (Array.isArray(value)) return value.some((item) => walk(item, true));
    if ((value as { kind?: unknown }).kind === "Telo.Import") return false;
    if (nested && writtenMetadataStamps(value).length > 0) return true;
    return Object.values(value).some((child) => walk(child, true));
  };
  return walk(manifest, false);
}
