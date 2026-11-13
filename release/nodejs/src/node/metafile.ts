/**
 * A unit's `metafile:` — a bundler metafile (esbuild's `inputs`) — read as inline
 * edges: every input another unit owns. Input paths are read relative to the
 * unit's directory, where its build runs; an input under no unit (a third-party
 * package) is no edge, and the unit's own sources are none either.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { UnitKey } from "../fragment.js";
import type { ResolvedUnit } from "../units.js";
import { owningUnit } from "./evidence.js";
import type { ReleaseWorkspace } from "./workspace.js";

export function metafileInlines(workspace: ReleaseWorkspace, unit: ResolvedUnit): Map<UnitKey, string[]> {
  const file = path.join(workspace.root, unit.metafile!);
  let meta: { inputs?: Record<string, unknown> };
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${unit.metafile}, the metafile unit '${unit.key}' declares, cannot be read ` +
        `(${err instanceof Error ? err.message : String(err)}). Build the unit first, or remove 'metafile:'.`,
    );
  }
  const owners = new Map<UnitKey, string[]>();
  for (const input of Object.keys(meta.inputs ?? {})) {
    if (input.includes(":")) continue;
    const abs = path.resolve(workspace.root, unit.dir, input);
    const relative = path.relative(workspace.root, abs).split(path.sep).join("/");
    if (relative.startsWith("..")) continue;
    const owner = owningUnit(workspace.units, relative);
    if (!owner || owner.key === unit.key) continue;
    owners.set(owner.key, [...(owners.get(owner.key) ?? []), relative]);
  }
  return owners;
}
