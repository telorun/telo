/**
 * A module's floor is never below the floors of the workspace siblings it imports
 * by relative path, transitively.
 *
 * No published CLI gates a relatively imported sibling's `requires:` (it reads the
 * sibling as a plain module), so measurement alone cannot see it: a dependent of a
 * sibling at `>=unreleased` would be measured to a floor its own import refuses.
 * The rule is therefore applied on top of the measurement, by both `telo release
 * floor` (which writes it) and `telo release check` (which holds a floor to it):
 * the floor is the maximum of the measured one and every sibling's, with
 * `>=unreleased` the highest and no floor the lowest.
 */

import { isLocalPathSource } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import { findModuleDoc, importSourceRefs } from "../commands/manifest-imports.js";
import { resolveSiblingManifest } from "../bundle/module-payload.js";
import { floorText, type Floor, type Measurement } from "./floor-measurement.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareFloors(a: Floor, b: Floor): number {
  const rank = (f: Floor): number => (f.kind === "none" ? 0 : f.kind === "version" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.kind === "version" ? semver.compare(a.version, (b as typeof a).version) : 0;
}

/** Workspace modules each module imports by relative path, by key. */
export function workspaceImports(workspace: Workspace): Map<string, string[]> {
  const byManifest = new Map(workspace.modules.map((m) => [path.resolve(m.manifestPath), m]));
  return new Map(workspace.modules.map((m) => [m.key, siblingImports(m, byManifest)]));
}

function siblingImports(module: DiscoveredModule, byManifest: Map<string, DiscoveredModule>): string[] {
  const docs = parseAllDocuments(fs.readFileSync(module.manifestPath, "utf8"), {
    customTags: defaultCustomTags,
  });
  const moduleDoc = findModuleDoc(docs);
  if (!moduleDoc) return [];
  const found: string[] = [];
  for (const ref of importSourceRefs(moduleDoc)) {
    if (!isLocalPathSource(ref.source)) continue;
    const sibling = byManifest.get(path.resolve(resolveSiblingManifest(module.dir, ref.source)));
    if (sibling && sibling !== module) found.push(sibling.key);
  }
  return found;
}

export interface SiblingFloor {
  /** The highest floor among the siblings reached. */
  floor: Floor;
  /** The sibling holding it, nearest first. */
  key?: string;
}

/** The highest floor among the siblings `key` reaches through relative imports. */
export function siblingFloor(
  key: string,
  imports: ReadonlyMap<string, readonly string[]>,
  floors: ReadonlyMap<string, Floor>,
): SiblingFloor {
  let best: SiblingFloor = { floor: { kind: "none" } };
  const seen = new Set([key]);
  let frontier = [...(imports.get(key) ?? [])];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sibling of frontier) {
      if (seen.has(sibling)) continue;
      seen.add(sibling);
      const floor = floors.get(sibling) ?? { kind: "none" as const };
      if (compareFloors(floor, best.floor) > 0) best = { floor, key: sibling };
      next.push(...(imports.get(sibling) ?? []));
    }
    frontier = next;
  }
  return best;
}

/** A measurement raised to the floors of the siblings; `sibling` names the one that decides it. */
export interface PropagatedMeasurement extends Measurement {
  sibling?: { key: string; floor: Floor };
}

export function propagate(measurement: Measurement, sibling: SiblingFloor): PropagatedMeasurement {
  if (sibling.key === undefined || compareFloors(sibling.floor, measurement.floor) <= 0) {
    return measurement;
  }
  return { floor: sibling.floor, sibling: { key: sibling.key, floor: sibling.floor } };
}

export function siblingClause(sibling: { key: string; floor: Floor }): string {
  return `imports ${sibling.key} at ${floorText(sibling.floor)}`;
}
