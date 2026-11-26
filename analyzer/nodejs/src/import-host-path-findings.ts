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
import {
  takenAt,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  World,
} from "./conditioned-expansion.js";
import { FALSE, type Condition } from "./presence-condition.js";
import { placeByProjectedKeys, placeByUnionKeys } from "./region-part.js";
import type { ScopedImportIndex } from "./scoped-import-index.js";
import { pathText } from "./template-expansion.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { HostPathInput } from "./host-path-slot.js";
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
  /** The scoped imports the union's declarations write. */
  readonly scopedImports: ScopedImportIndex;
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** An import the pass reads: a declaration of the union, or a scoped one at
 *  `unionKeys` of the declaration holding it. */
interface ImportSite {
  readonly declaration: ConditionedDeclaration;
  /** Where it is present: its declaration's, and every option on the way. */
  readonly holding: { readonly condition: Condition; readonly path: ConditionedDeclaration["path"] };
  readonly unionKeys?: readonly (string | number)[];
}

/** What one supplied input says at `witness`, and where that holds. */
function inputAt(
  inputs: ImportHostPathInputs,
  site: ImportSite,
  input: string,
  declared: Parameters<typeof hostPathInputFindings>[2],
  witness: World,
): { held: Condition; found: AnalysisDiagnostic[] } {
  const { union } = inputs;
  const { space } = union;
  const { declaration, unionKeys } = site;
  const [block, name] = input.split(".") as [string, string];
  const place = unionKeys
    ? placeByUnionKeys(union, declaration, [...unionKeys, block, name], witness)
    : placeByProjectedKeys(union, declaration, [block, name], witness);
  let held = space.and(site.holding.condition, place.path);
  if (!place.present) return { held, found: [] };
  const projected = union.project(place.node, witness.assignment, witness.forcing);
  held = space.and(held, space.and(place.position, projected.taken));
  const member = unionKeys ? placeByUnionKeys(union, declaration, unionKeys, witness) : undefined;
  const manifest = union.project(member ? member.node : declaration.manifest, witness.assignment, witness.forcing).value as ResourceManifest;
  const found = hostPathInputFindings(manifest, input, declared, projected.value, () => {
    const typed = inputs.facts({ declaration, unionKeys: place.unionKeys }, witness);
    if (!typed) return undefined;
    held = space.and(held, typed.condition);
    const fact = typed.facts[typed.facts.length - 1];
    if (!fact) return undefined;
    return { ...(fact.produced ? { schema: fact.produced } : {}), ...(fact.type !== undefined ? { celType: fact.type } : {}) };
  });
  if (!member) return { held, found };
  // A scoped import's finding is its holder's, at the member's place there;
  // placement re-roots the places its message quotes.
  const holder = declaration.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
  return {
    held,
    found: found.map((d) => ({
      ...d,
      data: {
        ...(d.data as Record<string, unknown>),
        resource: { kind: declaration.manifest.kind, name: String(holder?.name ?? "") },
        filePath: typeof holder?.source === "string" ? holder.source : undefined,
        path: pathText([...member.at, block, name]),
      },
    })) as AnalysisDiagnostic[],
  };
}

/** Every import the pass reads, with the host-path inputs of its library: the
 *  union's present `Telo.Import` declarations, then the scoped imports of the
 *  entry's own modules, each read where it is written. */
function importSites(inputs: ImportHostPathInputs): { site: ImportSite; inputs: [string, HostPathInput][] }[] {
  const { union, rootModules } = inputs;
  const out: { site: ImportSite; inputs: [string, HostPathInput][] }[] = [];
  for (const declaration of union.declarations) {
    if (declaration.condition === FALSE || declaration.unreachable || declaration.manifest.kind !== "Telo.Import") continue;
    // The library's host-path inputs are read off the import's metadata, which
    // no option varies.
    const found = hostPathInputsOf(declaration.manifest, rootModules);
    if (found.length > 0) out.push({ site: { declaration, holding: declaration }, inputs: found });
  }
  for (const [module, byAlias] of inputs.scopedImports) {
    if (!rootModules.has(module)) continue;
    for (const entries of byAlias.values()) {
      for (const entry of entries) {
        const declaration = entry.declaration as ConditionedDeclaration;
        if (entry.holding.condition === FALSE || declaration.unreachable) continue;
        const metadata = { ...(entry.member.metadata as object), module };
        const found = hostPathInputsOf({ ...entry.member, metadata } as unknown as ResourceManifest, rootModules);
        if (found.length > 0) out.push({ site: { declaration, holding: entry.holding, unionKeys: entry.unionKeys }, inputs: found });
      }
    }
  }
  return out;
}

/**
 * The host-path findings of every present import of the entry's own modules —
 * a declaration or a scoped import: each supplied input read at the first
 * configuration its import region holds in, its finding holding wherever the
 * reading does — and read once at the witness of each branch no configuration
 * takes.
 */
export function importHostPathFindings(inputs: ImportHostPathInputs): PassTable {
  const { union, universe } = inputs;
  const { space } = union;
  const sites = importSites(inputs);
  const found: ReadFinding[] = [];
  for (const { site, inputs: declaredInputs } of sites) {
    const { declaration } = site;
    for (const [input, declared] of declaredInputs) {
      reportKeyCost({ kind: "pass-reading", pass: "importHostPaths", declaration });
      let remaining = space.and(site.holding.condition, universe);
      while (remaining !== FALSE) {
        const witness = World.key(space.firstAssignment(remaining)!);
        const reading = inputAt(inputs, site, input, declared, witness);
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
      sites.flatMap(({ site, inputs: declaredInputs }) => {
        if (!takenAt(space, site.holding.condition, site.holding.path, branch.baseline, branch.forcing)) return [];
        return declaredInputs.flatMap(([input, declared]) =>
          inputAt(inputs, site, input, declared, branch.world).found.map((diagnostic) => ({
            branch,
            render: () => [diagnostic],
          })),
        );
      }),
    ),
  };
}
