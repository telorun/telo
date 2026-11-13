/**
 * `requires: telo: ">=unreleased"` written as the release that carries it.
 *
 * A floor naming syntax no published telo reads is `>=unreleased` until the
 * release making it readable is versioned; `telo release apply` (candidate or
 * final) then writes that release's surface — the `major.minor.patch` of the
 * telo line's planned version — into `requires.telo` and every `restrictions:`
 * entry's, spliced so layout and quoting are kept. The line is the group holding
 * the unit whose npm anchor is `@telorun/analyzer`.
 */

import type { ReleasePlan } from "@telorun/release";
import type { ReleaseWorkspace } from "@telorun/release/node";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { FloorFailure } from "./check-requires.js";
import { discoverModules } from "./workspace.js";

const SURFACE_PACKAGE = "@telorun/analyzer";
const UNRELEASED = ">=unreleased";

/** The surface the plan moves the telo line to, or `undefined` when it does not. */
export function plannedSurface(workspace: ReleaseWorkspace, plan: ReleasePlan): string | undefined {
  const analyzer = workspace.units.find((unit) =>
    unit.anchors.some((anchor) => anchor.ecosystem === "npm" && anchor.package.name === SURFACE_PACKAGE),
  );
  if (!analyzer) return undefined;
  const line = analyzer.group
    ? new Set(workspace.release.groups.get(analyzer.group) ?? [])
    : new Set([analyzer.key]);
  const moved = plan.units.find((unit) => line.has(unit.key));
  return moved ? /^\d+\.\d+\.\d+/.exec(moved.to)![0] : undefined;
}

/** `text` with every `>=unreleased` telo floor replaced by `>=<version>`. */
export function rewriteUnreleasedFloors(text: string, version: string): string {
  const owner = parseAllDocuments(text).find((doc) => {
    const kind = doc.get("kind");
    return kind === "Telo.Application" || kind === "Telo.Library";
  });
  const edits: { start: number; end: number; text: string }[] = [];
  const consider = (requires: unknown) => {
    if (!isMap(requires)) return;
    const node = requires.get("telo", true);
    if (!isScalar(node) || node.value !== UNRELEASED || !node.range) return;
    const [start, end] = node.range;
    const quote = /^['"]/.exec(text.slice(start, end))?.[0] ?? "";
    edits.push({ start, end, text: `${quote}>=${version}${quote}` });
  };
  if (owner && isMap(owner.contents)) {
    consider(owner.contents.get("requires", true));
    const restrictions = owner.contents.get("restrictions", true);
    if (isSeq(restrictions)) for (const entry of restrictions.items) if (isMap(entry)) consider(entry.get("requires", true));
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/**
 * `telo release check`'s refusal of a `>=unreleased` floor the plan strands: the
 * floor names the telo release this plan makes, so a plan that moves no telo
 * version leaves it naming a release nothing will carry.
 */
export function strandedUnreleasedFloors(workspace: ReleaseWorkspace, plan: ReleasePlan): FloorFailure[] {
  if (plannedSurface(workspace, plan)) return [];
  return discoverModules(workspace.root, workspace.units)
    .filter((module) => {
      const text = fs.readFileSync(module.manifestPath, "utf8");
      return text.includes(UNRELEASED) && rewriteUnreleasedFloors(text, "0.0.0") !== text;
    })
    .map((module) => ({
      module: module.key,
      code: "REQUIRES_FLOOR_TOO_HIGH",
      message:
        `requires a telo floor of '>=unreleased', but this release plan moves no telo version, so no release ` +
        `will carry the syntax it needs. Release the change that adds that syntax with this module, or measure ` +
        `the floor again with \`telo release floor --module ${module.key}\`.`,
    }));
}

/** Rewrite every workspace module's `>=unreleased` floors when the plan moves
 *  the telo line; the files written, workspace-relative. */
export function writeUnreleasedFloors(workspace: ReleaseWorkspace, plan: ReleasePlan): string[] {
  const surface = plannedSurface(workspace, plan);
  if (!surface) return [];
  const written: string[] = [];
  for (const module of discoverModules(workspace.root, workspace.units)) {
    const before = fs.readFileSync(module.manifestPath, "utf8");
    if (!before.includes(UNRELEASED)) continue;
    const after = rewriteUnreleasedFloors(before, surface);
    if (after === before) continue;
    fs.writeFileSync(module.manifestPath, after, "utf8");
    written.push(path.relative(workspace.root, module.manifestPath).split(path.sep).join("/"));
  }
  return written;
}
