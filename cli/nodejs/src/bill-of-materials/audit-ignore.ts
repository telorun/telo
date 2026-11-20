/**
 * The workspace marker's `audit:` block as `telo audit` reads it: where the
 * marker is, what it accepts, and where each entry sits for a finding to name.
 * Nothing else in the marker is this command's, so a problem outside `audit:`
 * (a `release:` typo) is left to the commands that read it.
 */

import { WORKSPACE_FILENAME, readWorkspaceConfig, type AuditIgnoreEntry } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import { LineCounter, isNode, parseDocument } from "yaml";
import { findWorkspaceRoot } from "../workspace-marker.js";

export interface MarkerPlace {
  readonly line: number;
  readonly column: number;
}

/** One accepted advisory with the place it is written. */
export interface IgnoreEntry extends AuditIgnoreEntry {
  readonly place: MarkerPlace;
}

export interface MarkerProblem {
  readonly code: string;
  readonly message: string;
  readonly place: MarkerPlace;
}

export interface AuditMarker {
  /** The marker's path as printed, relative to the working directory. */
  readonly file: string;
  readonly ignore: readonly IgnoreEntry[];
  /** Every problem inside `audit:`; any one refuses the audit. */
  readonly problems: readonly MarkerProblem[];
}

function placeOf(text: string, at: readonly (string | number)[]): MarkerPlace {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  for (let length = at.length; length >= 0; length--) {
    const node = length === 0 ? doc.contents : doc.getIn(at.slice(0, length), true);
    if (isNode(node) && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return { line: 1, column: 1 };
}

/** A problem belongs to `audit:` when it sits inside it, is about the whole
 *  file, or is a top-level key that is a near-miss of its name. */
function isAuditProblem(diagnostic: ReturnType<typeof readWorkspaceConfig>["diagnostics"][number]): boolean {
  if (diagnostic.severity !== "error") return false;
  if (diagnostic.path.length === 0 || diagnostic.path[0] === "audit") return true;
  return (
    diagnostic.code === "WORKSPACE_UNKNOWN_KEY" &&
    diagnostic.path.length === 1 &&
    diagnostic.data?.nearMiss === "audit"
  );
}

/** The marker governing the application at `manifest`, or none when the input
 *  is not a local path or no marker sits above it. */
export function readAuditMarker(manifest: string, cwd: string = process.cwd()): AuditMarker | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(manifest)) return undefined;
  const absolute = path.resolve(cwd, manifest);
  let start: string;
  try {
    start = fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    return undefined;
  }
  const root = findWorkspaceRoot(start);
  if (!root) return undefined;
  const file = path.join(root, WORKSPACE_FILENAME);
  const text = fs.readFileSync(file, "utf8");
  const read = readWorkspaceConfig(text, WORKSPACE_FILENAME);
  const shown = path.relative(cwd, file) || WORKSPACE_FILENAME;
  return {
    file: shown,
    ignore: (read.config.audit?.ignore ?? []).map((entry) => ({
      ...entry,
      place: placeOf(text, ["audit", "ignore", entry.index]),
    })),
    problems: read.diagnostics
      .filter(isAuditProblem)
      .map((d) => ({ code: d.code, message: d.message, place: placeOf(text, d.path) })),
  };
}
