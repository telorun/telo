/**
 * A unit's `CHANGELOG.md` entry, and splicing it into the file.
 *
 * The block is `## <version> - <date>`, `### <Kind>`, `* <body>`, a multi-line body's continuation lines indented. It is
 * prepended below the file's `# Changelog` heading: everything already written
 * stays untouched bytes. A changelog another tool started under a different
 * first heading (`# @scope/name`) keeps its history below, its heading becoming
 * `# Changelog`.
 */

import { FRAGMENT_KIND_ORDER, type FragmentKind } from "./bump-level.js";

export const CHANGELOG_HEADER = "# Changelog";

/** Where a unit's changelog lives, relative to the unit. */
export const CHANGELOG_FILE = "CHANGELOG.md";

export interface ChangelogRelease {
  readonly version: string;
  /** `YYYY-MM-DD`, passed in so a plan renders identically whenever rendered. */
  readonly date: string;
  readonly entries: readonly { readonly kind: FragmentKind; readonly body: string }[];
}

/** One release block, entries grouped under their kind in the vocabulary's order. */
export function renderChangelogRelease(release: ChangelogRelease): string {
  return [`## ${release.version} - ${release.date}`, ...renderChangelogEntries(release.entries)].join("\n") + "\n";
}

/** The entries' lines, under a `### <Kind>` heading per kind in the vocabulary's
 *  order: what a release block and a plan's markdown document both show. */
export function renderChangelogEntries(entries: ChangelogRelease["entries"]): string[] {
  const byKind = new Map<FragmentKind, string[]>();
  for (const entry of entries) {
    const list = byKind.get(entry.kind);
    if (list) list.push(entry.body);
    else byKind.set(entry.kind, [entry.body]);
  }
  const lines: string[] = [];
  for (const kind of FRAGMENT_KIND_ORDER) {
    const bodies = byKind.get(kind);
    if (!bodies) continue;
    lines.push(`### ${kind}`);
    for (const body of bodies) lines.push(`* ${indentContinuation(body)}`);
  }
  return lines;
}

/** Continuation lines indented two spaces so a list or code block stays inside
 *  its item; blank lines stay empty. */
function indentContinuation(body: string): string {
  return body
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : `  ${line}`))
    .join("\n");
}

/** Insert a release block below the file's first-level heading, which becomes
 *  `# Changelog`; a file with no such heading gets one. */
export function prependChangelogRelease(existing: string | undefined, block: string): string {
  const text = existing ?? "";
  const heading = /^#[ \t]+[^\n]*(\n|$)/.exec(text);
  if (!heading) {
    const rest = text.trim();
    return `${CHANGELOG_HEADER}\n\n${block}${rest ? `\n${rest}\n` : ""}`;
  }
  const kept = /^#[ \t]+Changelog\b/.test(heading[0]) ? heading[0].replace(/\n?$/, "\n") : `${CHANGELOG_HEADER}\n`;
  const after = text.slice(heading[0].length).replace(/^\n+/, "");
  return `${kept}\n${block}${after ? `\n${after}` : ""}`;
}
