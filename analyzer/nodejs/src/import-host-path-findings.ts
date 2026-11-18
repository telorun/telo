/**
 * What an import supplies for a library's host-path input, over every
 * configuration at once.
 *
 * A supplied value is read in the import's own region: the options on the way
 * to it decide which value it is. A tag that produces a plain string is the same
 * wherever it is read; a plain chain is typed by the key judging its CEL site
 * (`CelSiteSolution.factsAt`), so what it says holds under that key's class
 * together with the import's own region class — the options on the way to the
 * value.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { CelSiteSolution } from "./cel-site-solve.js";
import { isModuleKind } from "./module-kinds.js";
import {
  takenAt,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  World,
} from "./conditioned-expansion.js";
import { FALSE, type Condition } from "./presence-condition.js";
import { placeByProjectedKeys } from "./region-part.js";
import type { AnalysisDiagnostic } from "./types.js";
import { hostPathInputFindings, hostPathInputsOf } from "./validate-import-host-paths.js";
import { readDeadBranches, type PassTable, type ReadFinding } from "./union-passes.js";
import type { DeadBranchRun } from "./world-reader.js";
import { reportKeyCost } from "./cel-site-judgements.js";

export interface ImportHostPathInputs {
  readonly union: ConditionedExpansion;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly rootModules: ReadonlySet<string>;
  readonly facts: CelSiteSolution["factsAt"];
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** What one supplied input says at `witness`, and where that holds. */
function inputAt(
  inputs: ImportHostPathInputs,
  declaration: ConditionedDeclaration,
  input: string,
  declared: Parameters<typeof hostPathInputFindings>[2],
  witness: World,
): { held: Condition; found: AnalysisDiagnostic[] } {
  const { union } = inputs;
  const { space } = union;
  const [block, name] = input.split(".") as [string, string];
  const place = placeByProjectedKeys(union, declaration, [block, name], witness);
  let held = space.and(declaration.condition, place.path);
  if (!place.present) return { held, found: [] };
  const projected = union.project(place.node, witness.assignment, witness.forcing);
  held = space.and(held, space.and(place.position, projected.taken));
  const manifest = union.project(declaration.manifest, witness.assignment, witness.forcing).value as ResourceManifest;
  const found = hostPathInputFindings(manifest, input, declared, projected.value, () => {
    const typed = inputs.facts({ declaration, unionKeys: place.unionKeys }, witness);
    if (!typed) return undefined;
    held = space.and(held, typed.condition);
    const fact = typed.facts[typed.facts.length - 1];
    return fact?.produced;
  });
  return { held, found };
}

/**
 * The host-path findings of every present import of the entry's own modules:
 * each supplied input read at the first configuration its import region holds
 * in, its finding holding wherever the reading does — and read once at the
 * witness of each branch no configuration takes.
 */
export function importHostPathFindings(inputs: ImportHostPathInputs): PassTable {
  const { union, universe, rootModules } = inputs;
  const { space } = union;
  const imports = union.declarations.filter(
    (d) => d.condition !== FALSE && !d.unreachable && d.manifest.kind === "Telo.Import" && !isModuleKind(d.manifest.kind),
  );
  const found: ReadFinding[] = [];
  for (const declaration of imports) {
    const written = union.project(declaration.manifest, {}).value as ResourceManifest;
    for (const [input, declared] of hostPathInputsOf(written, rootModules)) {
      reportKeyCost({ kind: "pass-reading", pass: "importHostPaths", declaration });
      let remaining = space.and(declaration.condition, universe);
      while (remaining !== FALSE) {
        const witness = World.key(space.firstAssignment(remaining)!);
        const reading = inputAt(inputs, declaration, input, declared, witness);
        if (!space.holds(reading.held, witness.assignment)) {
          throw new Error(`internal: the host-path reading of '${input}' of ${String(declaration.manifest.metadata?.name)} does not hold where it was read.`);
        }
        for (const diagnostic of reading.found) found.push({ held: reading.held, render: () => [diagnostic] });
        remaining = space.and(remaining, space.not(reading.held));
      }
    }
  }
  return {
    found,
    dead: readDeadBranches("importHostPaths", inputs.deadBranches, (branch) =>
      imports.flatMap((declaration) => {
        if (!takenAt(space, declaration.condition, declaration.path, branch.baseline, branch.forcing)) return [];
        const written = union.project(declaration.manifest, {}).value as ResourceManifest;
        return hostPathInputsOf(written, rootModules).flatMap(([input, declared]) =>
          inputAt(inputs, declaration, input, declared, branch.world).found.map((diagnostic) => ({
            branch,
            render: () => [diagnostic],
          })),
        );
      }),
    ),
  };
}
