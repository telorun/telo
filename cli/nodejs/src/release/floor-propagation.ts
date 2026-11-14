/**
 * A module's floor is never below the floors of the workspace siblings it imports
 * by relative path, transitively.
 *
 * No published CLI gates a relatively imported sibling's `requires:` (it reads the
 * sibling as a plain module), so measurement alone cannot see it: a dependent of a
 * sibling at `>=unreleased` would be measured to a floor its own import refuses.
 * A sibling's `restrictions:` entry is the other half of the same problem: a CLI
 * that reads the key gates the entry at the dependent, an older one ignores it,
 * so acceptance is not monotonic across releases and the search lands below the
 * release that first refuses the dependent. The rule is therefore applied on top
 * of the measurement, by both `telo release floor` (which writes it) and `telo
 * release check` (which holds a floor to it): the floor is the maximum of the
 * measured one and what every sibling imposes — its `requires.telo`, raised to the
 * highest `telo` bound of a `restrictions:` entry covering its own version — with
 * `>=unreleased` the highest and no floor the lowest. A module's own restrictions
 * never raise its own floor: the measurement copy neutralises them by design.
 */

import { declaringVersion, isLocalPathSource, lowerBound, readRestrictions, restrictionCovers } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import { findModuleDoc, importSourceRefs } from "../commands/manifest-imports.js";
import { resolveSiblingManifest } from "../bundle/module-payload.js";
import {
  NO_FLOOR,
  UNRELEASED,
  declaredFloor,
  floorText,
  type Floor,
  type Measurement,
} from "./floor-measurement.js";
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

/** What a module imposes on the dependents importing it. */
export interface ImportedFloor {
  floor: Floor;
  /** A `restrictions:` entry decides it, above the module's `requires.telo`. */
  restricted: boolean;
}

/**
 * The highest `telo` lower bound among the `restrictions:` entries covering the
 * manifest's own version; `undefined` when no covering entry states one.
 */
export function restrictionFloor(text: string): Floor | undefined {
  const owner = parseAllDocuments(text, { customTags: defaultCustomTags }).find((d) => {
    const kind = d.get("kind");
    return kind === "Telo.Application" || kind === "Telo.Library";
  });
  const doc = owner?.toJS() as Record<string, unknown> | undefined;
  const declaring = declaringVersion(doc);
  let best: Floor | undefined;
  for (const entry of readRestrictions(doc).entries) {
    const range = entry.requires.telo;
    if (!range || !restrictionCovers(entry, declaring, declaring)) continue;
    const low = range.unreleased ? undefined : lowerBound(range);
    const floor: Floor = range.unreleased
      ? UNRELEASED
      : low === undefined
        ? NO_FLOOR
        : { kind: "version", version: low.raw };
    if (best === undefined || compareFloors(floor, best) > 0) best = floor;
  }
  return best;
}

/** `own` raised to the restriction floor where that is higher. */
export function imposedFloor(own: Floor, restriction: Floor | undefined): ImportedFloor {
  if (restriction !== undefined && compareFloors(restriction, own) > 0) {
    return { floor: restriction, restricted: true };
  }
  return { floor: own, restricted: false };
}

/** The floor a manifest imposes on its dependents, read from its text. */
export function importedFloor(text: string): ImportedFloor {
  return imposedFloor(declaredFloor(text).floor, restrictionFloor(text));
}

/** The sibling that decides a dependent's floor. */
export interface DecidingSibling {
  key: string;
  floor: Floor;
  /** The sibling's `restrictions:` entry decides it, not its `requires.telo`. */
  restricted?: boolean;
}

export interface SiblingFloor {
  /** The highest floor among the siblings reached. */
  floor: Floor;
  /** The sibling holding it, nearest first. */
  key?: string;
  restricted?: boolean;
}

/** The highest floor among the siblings `key` reaches through relative imports. */
export function siblingFloor(
  key: string,
  imports: ReadonlyMap<string, readonly string[]>,
  floors: ReadonlyMap<string, ImportedFloor>,
): SiblingFloor {
  let best: SiblingFloor = { floor: { kind: "none" } };
  const seen = new Set([key]);
  let frontier = [...(imports.get(key) ?? [])];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sibling of frontier) {
      if (seen.has(sibling)) continue;
      seen.add(sibling);
      const imposed = floors.get(sibling) ?? { floor: { kind: "none" as const }, restricted: false };
      if (compareFloors(imposed.floor, best.floor) > 0) {
        best = { floor: imposed.floor, key: sibling, restricted: imposed.restricted };
      }
      next.push(...(imports.get(sibling) ?? []));
    }
    frontier = next;
  }
  return best;
}

/** A measurement raised to the floors of the siblings; `sibling` names the one that decides it. */
export interface PropagatedMeasurement extends Measurement {
  sibling?: DecidingSibling;
}

export function propagate(measurement: Measurement, sibling: SiblingFloor): PropagatedMeasurement {
  if (sibling.key === undefined || compareFloors(sibling.floor, measurement.floor) <= 0) {
    return measurement;
  }
  return { floor: sibling.floor, sibling: decidingSibling({ ...sibling, key: sibling.key }) };
}

/** The sibling record a verdict or a measurement carries, from a resolved lookup. */
export function decidingSibling(sibling: SiblingFloor & { key: string }): DecidingSibling {
  return sibling.restricted
    ? { key: sibling.key, floor: sibling.floor, restricted: true }
    : { key: sibling.key, floor: sibling.floor };
}

export function siblingClause(sibling: DecidingSibling): string {
  return sibling.restricted
    ? `imports ${sibling.key}, restricted to ${floorText(sibling.floor)}`
    : `imports ${sibling.key} at ${floorText(sibling.floor)}`;
}
