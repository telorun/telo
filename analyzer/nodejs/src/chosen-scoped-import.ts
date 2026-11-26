/**
 * A `Telo.Import` a choice declares at a scope-member position: a branch named
 * by the tag's `metadata`, like any member a choice declares there. The loader
 * follows it and stamps its identity on the branch itself — each branch may
 * reach another library — so the branch's `metadata` holds the loader's stamps
 * and nothing an author wrote, and the declaration a configuration makes of it
 * carries them under the tag's name.
 *
 * Browser-safe.
 */
import STAMPS from "./metadata-stamps.json" with { type: "json" };

const LOADER_STAMPS: ReadonlySet<string> = new Set(STAMPS.map((s) => s.field));

/** Whether `value` is a `Telo.Import` branch. */
export function isImportBranch(value: unknown): boolean {
  return (value as { kind?: unknown } | null | undefined)?.kind === "Telo.Import";
}

/** Whether a branch's `metadata` holds the loader's stamps alone — or nothing. */
export function holdsOnlyStamps(value: unknown): boolean {
  const metadata = (value as { metadata?: unknown } | null | undefined)?.metadata;
  if (metadata === undefined) return true;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return Object.keys(metadata).every((key) => LOADER_STAMPS.has(key));
}

/** The metadata a chosen declaration carries: the tag's, and — for an import
 *  branch — the identity the loader stamped on the branch. */
export function withBranchStamps(declared: Record<string, unknown>, branch: unknown): Record<string, unknown> {
  if (!isImportBranch(branch)) return declared;
  const stamps = (branch as { metadata?: unknown }).metadata;
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) return declared;
  const own = Object.fromEntries(Object.entries(stamps).filter(([key]) => LOADER_STAMPS.has(key)));
  return Object.keys(own).length === 0 ? declared : { ...declared, ...own };
}
