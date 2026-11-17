/**
 * A release plan as a CommonMark document — release notes or a release PR's
 * body with no renderer of the host's own. Headings are levels 2 and 3 only:
 * the host owns level 1 and any introduction.
 *
 * Units carrying changelog entries come first, each under its own heading with
 * its entries exactly as `CHANGELOG.md` shows them; the rest share one closing
 * section. With a limit the document is the first stage that fits it, each
 * stage giving up what a reader needs least and saying so; with none nothing is
 * cut. Lengths count Unicode code points, the trailing newline included.
 */

import { describeReasonsWith } from "./bump-reason-text.js";
import { renderChangelogEntries } from "./changelog.js";
import type { PlannedUnit, ReleasePlan } from "./release-plan.js";

/** What an empty plan says, in every output. */
export const NOTHING_TO_RELEASE = "Nothing to release — every unit matches the ledger.";

/** No entry is cut shorter than this. */
export const MIN_ENTRY_CAP = 200;

const NO_ENTRY_HEADING = "## Units with no changelog entry";

export function codePointLength(text: string): number {
  return [...text].length;
}

/** `text` as a code span, its fence longer than any backtick run inside it. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const note = (text: string) => `_${text}_`;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Whitespace runs as one space, ends trimmed — the same set in both halves. */
function flatten(body: string): string {
  return body.split(/[ \t\n\r\f\v]+/).filter((part) => part !== "").join(" ");
}

/** A body over `cap` code points, flattened and cut at its last space before
 *  the cap (hard at the cap when it has none), ending in "…"; else `undefined`. */
export function cutEntry(body: string, cap: number): string | undefined {
  const points = [...flatten(body)];
  if (points.length <= cap) return undefined;
  const head = points.slice(0, cap - 1);
  let end = head.length;
  if (points[cap - 1] !== " ") {
    const space = head.lastIndexOf(" ");
    if (space !== -1) end = space;
  }
  return `${head.slice(0, end).join("")}…`;
}

function unitHeading(unit: PlannedUnit): string {
  return `## ${code(unit.key)} ${unit.from} → ${unit.to}`;
}

function why(unit: PlannedUnit): string {
  return `${unit.level} — ${describeReasonsWith(unit, code)}`;
}

function tagLine(unit: PlannedUnit): string {
  return unit.group ? `Group ${code(unit.group)} · tag ${code(unit.tag)}` : `Tag ${code(unit.tag)}`;
}

function newVersions(units: readonly PlannedUnit[]): string {
  return `${units.map((unit) => `${code(unit.key)} ${unit.to}`).join(", ")}.`;
}

interface Detail {
  /** The no-entry section as one paragraph, reasons dropped. */
  readonly compact: boolean;
  /** The cap entries are cut to, when cutting. */
  readonly cap?: number;
}

function described(plan: ReleasePlan, detail: Detail): string {
  const withEntries = plan.units.filter((unit) => unit.entries.length > 0);
  const without = plan.units.filter((unit) => unit.entries.length === 0);
  const blocks: string[] = [];
  let cut = false;
  for (const unit of withEntries) {
    const entries = unit.entries.map((entry) => {
      const shortened = detail.cap === undefined ? undefined : cutEntry(entry.body, detail.cap);
      if (shortened !== undefined) cut = true;
      return { kind: entry.kind, body: shortened ?? entry.body };
    });
    blocks.push([unitHeading(unit), "", why(unit), "", tagLine(unit), "", ...renderChangelogEntries(entries)].join("\n"));
  }
  if (without.length > 0) {
    blocks.push(
      detail.compact
        ? [NO_ENTRY_HEADING, "", newVersions(without), "", note("Their reasons, groups and tags are left out to fit the length limit.")].join("\n")
        : [
            NO_ENTRY_HEADING,
            "",
            ...without.map(
              (unit) =>
                `- ${code(unit.key)} ${unit.from} → ${unit.to} · ${why(unit)}${unit.group ? ` · group ${code(unit.group)}` : ""} · tag ${code(unit.tag)}`,
            ),
          ].join("\n"),
    );
  }
  if (cut) blocks.unshift(note("Entries cut to fit the length limit end in “…”."));
  return `${blocks.join("\n\n")}\n`;
}

function listed(plan: ReleasePlan): string {
  return `${newVersions(plan.units)}\n\n${note("Changelog entries, reasons and tags are left out to fit the length limit.")}\n`;
}

function counted(plan: ReleasePlan): string {
  const carrying = plan.units.filter((unit) => unit.entries.length > 0).length;
  return (
    `${plural(plan.units.length, "unit moves", "units move")}, ${carrying} with changelog entries; ` +
    "the list is left out to fit the length limit.\n"
  );
}

/** The largest cap at or above {@link MIN_ENTRY_CAP} whose document fits, if any. */
function fittingCap(plan: ReleasePlan, maxLength: number): string | undefined {
  let longest = 0;
  for (const unit of plan.units) {
    for (const entry of unit.entries) longest = Math.max(longest, codePointLength(flatten(entry.body)));
  }
  let low = MIN_ENTRY_CAP;
  let high = longest - 1;
  let best: string | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const document = described(plan, { compact: true, cap });
    if (codePointLength(document) <= maxLength) {
      best = document;
      low = cap + 1;
    } else high = cap - 1;
  }
  return best;
}

/**
 * The plan's document. With `maxLength`, the first stage within it: the whole
 * document; the no-entry section compacted; long entries cut; every unit as
 * one paragraph; one counting sentence. A plan no stage fits is refused,
 * naming the shortest length its document can take.
 */
export function renderPlanMarkdown(plan: ReleasePlan, maxLength?: number): string {
  if (plan.units.length === 0) {
    const empty = `${NOTHING_TO_RELEASE}\n`;
    if (maxLength !== undefined && codePointLength(empty) > maxLength) throw refusal(codePointLength(empty), maxLength);
    return empty;
  }
  const full = described(plan, { compact: false });
  if (maxLength === undefined || codePointLength(full) <= maxLength) return full;
  const hasNoEntryUnits = plan.units.some((unit) => unit.entries.length === 0);
  const stages: (() => string | undefined)[] = [
    () => (hasNoEntryUnits ? described(plan, { compact: true }) : undefined),
    () => fittingCap(plan, maxLength),
    () => listed(plan),
    () => counted(plan),
  ];
  let shortest = codePointLength(full);
  for (const stage of stages) {
    const document = stage();
    if (document === undefined) continue;
    const length = codePointLength(document);
    if (length <= maxLength) return document;
    shortest = Math.min(shortest, length);
  }
  throw refusal(shortest, maxLength);
}

function refusal(shortest: number, maxLength: number): Error {
  return new Error(
    `No markdown document of this plan fits in ${maxLength} code points: the shortest takes ${shortest}.`,
  );
}
