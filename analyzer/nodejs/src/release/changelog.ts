/**
 * Rendering a module's `CHANGELOG.md` entry, and splicing it into the file.
 *
 * The output shape is the one changie was configured to emit — `## <version> -
 * <date>`, `### <Kind>`, `* <body>` — so a module's history stays one document
 * across the handover rather than changing format mid-file.
 *
 * Prepending rather than rewriting: a changelog is append-only history, and the
 * only edit ever made to it is inserting the newest release above the previous
 * one. Everything already written is untouched bytes.
 */

import { FRAGMENT_KIND_ORDER, type FragmentKind } from "./bump-level.js";

export const CHANGELOG_HEADER = "# Changelog";

export interface ChangelogRelease {
  readonly version: string;
  /** `YYYY-MM-DD`. Passed in rather than read from a clock, so a plan renders
   *  identically whenever it is rendered and a test needs no clock control. */
  readonly date: string;
  readonly entries: readonly { readonly kind: FragmentKind; readonly body: string }[];
}

/** One release block. Entries group under their kind, in the vocabulary's own
 *  order, so two releases never disagree about where `Fixed` sits. */
export function renderChangelogRelease(release: ChangelogRelease): string {
  const byKind = new Map<FragmentKind, string[]>();
  for (const entry of release.entries) {
    const list = byKind.get(entry.kind);
    if (list) list.push(entry.body);
    else byKind.set(entry.kind, [entry.body]);
  }

  const lines = [`## ${release.version} - ${release.date}`];
  for (const kind of FRAGMENT_KIND_ORDER) {
    const bodies = byKind.get(kind);
    if (!bodies) continue;
    lines.push(`### ${kind}`);
    for (const body of bodies) lines.push(`* ${body}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Insert a release block below the file's `# Changelog` header, creating the
 * file's skeleton when it has none.
 *
 * A module with no changelog yet is the ordinary case for a new module, so this
 * writes the header rather than failing — the alternative is a release that
 * stops to ask for an empty file to be created by hand.
 */
export function prependChangelogRelease(existing: string | undefined, block: string): string {
  const text = existing ?? "";
  const header = text.match(/^#\s+Changelog[^\n]*\n/);
  if (!header) {
    const rest = text.trim();
    return `${CHANGELOG_HEADER}\n\n${block}${rest ? `\n${rest}\n` : ""}`;
  }
  const after = text.slice(header[0].length).replace(/^\n+/, "");
  return `${header[0]}\n${block}${after ? `\n${after}` : ""}`;
}
