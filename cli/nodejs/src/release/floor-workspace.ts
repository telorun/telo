/**
 * `telo release floor` over a workspace: measure each module's floor, siblings
 * first, and write what measurement says — up or down.
 *
 * **Import order is part of the result.** No published CLI gates a relatively
 * imported sibling's `requires:`, so a dependent's floor is the maximum of its
 * measurement and its siblings' floors (`floor-propagation.ts`). A module is
 * therefore measured only after the siblings it imports have been, and a floor is
 * written before the next level runs. When anything fails — the registry, a run
 * that says nothing about its manifest — every file written so far is restored:
 * the command writes all of it or none of it.
 */

import * as fs from "node:fs";
import {
  FloorMeasurementError,
  FloorProbe,
  OLDEST_CLI_READING_REQUIRES,
  declaredFloor,
  describeReading,
  floorText,
  listPublishedFinals,
  measureFloors,
  npxRunner,
  sameFloor,
  type CliRunner,
  type Floor,
} from "./floor-measurement.js";
import { propagate, siblingClause, siblingFloor, workspaceImports, type PropagatedMeasurement } from "./floor-propagation.js";
import { writeFloor } from "./requires-text.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

export interface FloorResult {
  module: DiscoveredModule;
  from: Floor;
  to: Floor;
  /** What the line says after the arrow, or beside `unchanged`. */
  note?: string;
}

export interface FloorOptions {
  runner?: CliRunner;
  finals?: readonly string[];
}

export async function measureAndWriteFloors(
  workspace: Workspace,
  selected: readonly DiscoveredModule[],
  options: FloorOptions = {},
): Promise<FloorResult[]> {
  for (const module of selected) {
    const { ceiling } = declaredFloor(fs.readFileSync(module.manifestPath, "utf8"));
    if (ceiling) {
      throw new FloorMeasurementError(
        `${module.key}/telo.yaml: requires.telo declares an upper bound; requires.telo is a floor ` +
          `only. Move the ceiling to a restrictions: entry without versions and remove it from ` +
          `requires.telo, then run \`telo release floor\` again.`,
      );
    }
  }

  const finals = options.finals ?? (await listPublishedFinals());
  const probe = new FloorProbe(options.runner ?? npxRunner);
  const selectedKeys = new Set(selected.map((m) => m.key));
  const imports = workspaceImports(workspace);

  const originals = new Map<string, string>();
  const results = new Map<string, FloorResult>();
  const floors = new Map<string, Floor>(
    workspace.modules.map((m) => [m.key, declaredFloor(fs.readFileSync(m.manifestPath, "utf8")).floor]),
  );

  try {
    let remaining = [...selected];
    while (remaining.length > 0) {
      const level = remaining.filter((m) =>
        reachableSelected(m.key, imports, selectedKeys).every((key) => results.has(key)),
      );
      if (level.length === 0) {
        throw new FloorMeasurementError(
          `the modules ${remaining.map((m) => m.key).join(", ")} import each other in a cycle.`,
        );
      }
      remaining = remaining.filter((m) => !level.includes(m));

      const measurements = await measureFloors(
        level.map((m) => ({
          key: m.key,
          manifestPath: m.manifestPath,
          text: fs.readFileSync(m.manifestPath, "utf8"),
        })),
        { probe, finals },
      );
      for (const module of level) {
        const text = fs.readFileSync(module.manifestPath, "utf8");
        const from = floors.get(module.key)!;
        const measurement = propagate(
          measurements.get(module.key)!,
          siblingFloor(module.key, imports, floors),
        );
        const to = measurement.floor;
        if (!sameFloor(from, to)) {
          originals.set(module.manifestPath, originals.get(module.manifestPath) ?? text);
          const written = writeFloor(
            text,
            to.kind === "none" ? null : to.kind === "unreleased" ? "unreleased" : to.version,
          );
          fs.writeFileSync(module.manifestPath, written.text);
        }
        floors.set(module.key, to);
        results.set(module.key, {
          module,
          from,
          to,
          note: noteFor(from, measurement),
        });
      }
    }
  } catch (err) {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
    throw err;
  }
  return selected.map((m) => results.get(m.key)!);
}

/** Selected modules `key` reaches through relative imports, however many modules between. */
function reachableSelected(
  key: string,
  imports: ReadonlyMap<string, readonly string[]>,
  selected: ReadonlySet<string>,
): string[] {
  const seen = new Set([key]);
  const stack = [...(imports.get(key) ?? [])];
  const found: string[] = [];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (selected.has(next)) found.push(next);
    stack.push(...(imports.get(next) ?? []));
  }
  return found;
}

function noteFor(from: Floor, measurement: PropagatedMeasurement): string | undefined {
  const to = measurement.floor;
  if (measurement.sibling) return siblingClause(measurement.sibling);
  if (to.kind === "unreleased") {
    if (sameFloor(from, to)) return undefined;
    return measurement.reading
      ? `no published telo accepts it; ${describeReading(measurement.reading)}`
      : undefined;
  }
  if (to.kind === "none" && !sameFloor(from, to)) {
    return `accepted by ${OLDEST_CLI_READING_REQUIRES}, the oldest telo that reads requires:`;
  }
  return undefined;
}

/** One output line, as `telo release floor` prints it. */
export function floorLine(result: FloorResult): string {
  const note = result.note ? ` (${result.note})` : "";
  if (sameFloor(result.from, result.to)) {
    return `${result.module.key}: ${floorText(result.to)} unchanged${result.note ? note : ""}`;
  }
  return `${result.module.key}: ${floorText(result.from)} → ${floorText(result.to)}${note}`;
}
