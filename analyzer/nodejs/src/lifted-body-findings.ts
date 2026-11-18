/**
 * A union pass's findings inside a lifted template body, read unit by unit:
 * each unit of the body (`template-body-sites.ts`) is read at one witness per
 * way of holding it and the units it depends on, so the readings grow with
 * the units and the options in them — never with the ways of deciding the
 * whole body. A finding holds where the classes it was read under hold.
 *
 * Browser-safe.
 */
import { Alternatives, relocatorOf, type ConditionedDeclaration, World } from "./conditioned-expansion.js";
import type { DeclarationPart, TemplateVariantOf } from "./key-parts.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { isAtOrAbove } from "./relation-sites.js";
import { Placement } from "./placement.js";
import { syntheticOrigins } from "./rewrite-synthetic-origins.js";
import { ScopeMembers } from "./scope-members.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";
import { parseKeys } from "./template-expansion.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { PassBodyFinding } from "./union-passes.js";
import { isRefSentinel } from "@telorun/templating";
import { localRefName } from "./ref-sentinel-target.js";

/** A finding of a reading, in the raw form a run's own takes, with the
 *  configurations it holds in beside the body's classes. */
export interface RawBodyFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly held: Condition;
}

export interface LiftedBodyInputs {
  readonly space: ConditionSpace;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly declaration: ConditionedDeclaration;
  readonly units: readonly TemplateBodyUnit[];
  /** The definition normalized at a witness, its body as the witness decides it. */
  readonly partAt: (witness: World) => DeclarationPart;
  /** What the pass finds in the definition as `part` holds it. */
  readonly find: (part: DeclarationPart, witness: World) => readonly RawBodyFinding[];
  /** The units a finding in `unit` may depend on beside it; by default every
   *  unit that may declare an entry `unit` names or declares. */
  readonly dependsOn?: (unit: TemplateBodyUnit) => readonly TemplateBodyUnit[];
}

/** `found`, read in `part` — a template definition's body decided as
 *  `template` — moved to where it is written, as a run places a finding of the
 *  definition. */
export function placedInPart(
  part: Pick<DeclarationPart, "members" | "kindMembers" | "manifests" | "projection">,
  found: AnalysisDiagnostic[],
  template: TemplateVariantOf | undefined,
): AnalysisDiagnostic[] {
  return new Placement({
    scopeMembers: new ScopeMembers([...part.members, ...part.kindMembers]),
    origins: syntheticOrigins(part.manifests),
    ...(template ? { bodies: { variants: [template] } } : {}),
    expansion: relocatorOf([part.projection]),
  }).place(found);
}

/** `found`, read in `part`, moved off what extraction drew out of it and off
 *  its scope members onto their places in it: the raw form a run's own
 *  finding takes before its expansion is undone. */
export function rawInPart(
  part: Pick<DeclarationPart, "members" | "kindMembers" | "manifests">,
  found: AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  return new Placement({
    scopeMembers: new ScopeMembers([...part.members, ...part.kindMembers]),
    origins: syntheticOrigins(part.manifests),
  }).place(found);
}

/** The names a unit may declare an entry under, any option taken; `dynamic`
 *  where one is not a literal. */
function declaredNames(unit: TemplateBodyUnit): { names: Set<string>; dynamic: boolean } {
  const names = new Set<string>();
  let dynamic = false;
  if (unit.keys[0] !== "resources") return { names, dynamic };
  const take = (value: unknown): void => {
    if (value instanceof Alternatives) {
      for (const option of value.options) if (option.present) take(option.value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) take(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const name = (value as { metadata?: { name?: unknown } }).metadata?.name;
    if (typeof name === "string") names.add(name);
    else if (name !== undefined) dynamic = true;
  };
  take(unit.node);
  return { names, dynamic };
}

/** Every name a `!ref` in a unit may name, any option taken. */
function referencedNames(unit: TemplateBodyUnit): Set<string> {
  return refNamesIn(unit.node);
}

/** Every unit of `units` that may declare an entry under one of `names`, or
 *  names an entry by an expression. */
export function unitsDeclaring(units: readonly TemplateBodyUnit[], names: ReadonlySet<string>): TemplateBodyUnit[] {
  return units.filter((unit) => {
    const declared = declaredNames(unit);
    return declared.dynamic || [...declared.names].some((name) => names.has(name));
  });
}

/** Every name a `!ref` in `value` names, any option taken. */
export function refNamesIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new Set<object>();
  const visit = (at: unknown): void => {
    if (at instanceof Alternatives) {
      for (const option of at.options) if (option.present) visit(option.value);
      return;
    }
    if (at === null || typeof at !== "object" || seen.has(at)) return;
    if (isRefSentinel(at)) {
      out.add(localRefName(at));
      return;
    }
    seen.add(at);
    for (const field of Array.isArray(at) ? at : Object.values(at)) visit(field);
  };
  visit(value);
  return out;
}

/** Every unit that may declare an entry `unit` names or declares, and every
 *  unit naming an entry by an expression: what decides whether a name it
 *  holds reaches a sibling, or collides with one. */
export function namedDependencies(units: readonly TemplateBodyUnit[]): (unit: TemplateBodyUnit) => readonly TemplateBodyUnit[] {
  const declared = new Map(units.map((unit) => [unit, declaredNames(unit)]));
  return (unit) => {
    const names = new Set([...referencedNames(unit), ...declared.get(unit)!.names]);
    return units.filter(
      (other) => other !== unit && (declared.get(other)!.dynamic || [...declared.get(other)!.names].some((name) => names.has(name))),
    );
  };
}

const identityOf = (d: AnalysisDiagnostic): string => {
  const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
  return JSON.stringify([d.code, data?.resource?.kind, data?.resource?.name, data?.filePath, data?.path, d.message]);
};

/** How a lifted body is read unit by unit: the definition, its units and
 *  what a finding in a unit may depend on. */
export type UnitReadingInputs = Pick<LiftedBodyInputs, "space" | "universe" | "declaration" | "units" | "dependsOn">;

/**
 * Each reading of a lifted definition's body unit by unit: for each unit, one
 * witness per class of the unit and the units it depends on — `live` told the
 * unit and the condition every configuration reads it alike under — then, for
 * each branch of a unit no value the definition can be given takes, one
 * witness forced at its baseline — `dead` told the branch and its unit.
 */
export function unitReadings(
  inputs: UnitReadingInputs,
  live: (witness: World, unit: TemplateBodyUnit, condition: Condition, whole: () => Condition) => void,
  dead: (witness: World, branch: TemplateBodyUnit["dead"][number], unit: TemplateBodyUnit) => void,
): void {
  const { space, universe, declaration, units } = inputs;
  const dependsOn = inputs.dependsOn ?? namedDependencies(units);
  const present = space.and(declaration.condition, universe);
  for (const unit of units) {
    const reach = [unit, ...dependsOn(unit)];
    let remaining = present;
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      const classOf = (list: readonly TemplateBodyUnit[]) =>
        list.reduce((held, each) => space.and(held, each.classAt(witness, false).condition), TRUE as Condition);
      const condition = classOf(reach);
      if (!space.holds(condition, witness.assignment)) {
        throw new Error(`internal: a body unit's class of ${String(declaration.manifest.metadata?.name)} does not hold where it was read.`);
      }
      let whole: Condition | undefined;
      live(witness, unit, condition, () => (whole ??= classOf(units)));
      remaining = space.and(remaining, space.not(condition));
    }
  }
  const first = space.firstAssignment(present);
  if (!first) return;
  for (const unit of units) {
    for (const branch of unit.dead) dead(branch.world.asBody(first), branch, unit);
  }
}

/** The unit of `units` a written `path` lies in. */
export function unitAt(units: readonly TemplateBodyUnit[], path: unknown): TemplateBodyUnit | undefined {
  if (typeof path !== "string") return undefined;
  const keys = parseKeys(path);
  return units.find((unit) => isAtOrAbove(unit.keys, keys));
}

/** Whether a written `path` lies beneath the written branch at `branch`. */
export function underBranch(branch: string, path: unknown): boolean {
  return typeof path === "string" && isAtOrAbove(parseKeys(branch), parseKeys(path));
}

/**
 * Every finding of `inputs.find` in a lifted definition's body, each with the
 * condition it holds under ({@link unitReadings}): a live reading keeps what
 * is found in its unit, a forced one what is found beneath its branch.
 * Findings are in the order the reading that first finds each lists them in.
 */
export function liftedBodyFindings(inputs: LiftedBodyInputs): PassBodyFinding[] {
  const { space, universe, declaration, units } = inputs;
  const definition = declaration.manifest;
  const found = new Map<string, { diagnostic: AnalysisDiagnostic; live?: Condition; configuration: Condition; dead?: { sentinel: object; branch: string }; order: readonly number[] }>();
  let sequence = 0;
  const read = (witness: World): { diagnostic: AnalysisDiagnostic; held: Condition }[] => {
    const part = inputs.partAt(witness);
    const raw = inputs.find(part, witness);
    const placed = placedInPart(part, raw.map((r) => r.diagnostic), part.template);
    return placed.map((diagnostic, i) => ({ diagnostic, held: raw[i]!.held }));
  };
  const present = space.and(declaration.condition, universe);
  unitReadings(
    inputs,
    (witness, unit, condition, whole) => {
      for (const [index, { diagnostic, held }] of read(witness).entries()) {
        const at = unitAt(units, (diagnostic.data as { path?: unknown } | undefined)?.path);
        if (at !== undefined && at !== unit) continue;
        const live = space.and(space.and(at ? condition : whole(), held), present);
        if (live === FALSE) continue;
        const id = identityOf(diagnostic);
        const known = found.get(id);
        if (known && known.live !== undefined) {
          known.live = space.or(known.live, live);
          known.configuration = space.or(known.configuration, space.existsDefinitions(live));
        } else if (!known) {
          found.set(id, { diagnostic, live, configuration: space.existsDefinitions(live), order: [index, sequence++] });
        }
      }
    },
    (witness, branch) => {
      for (const [index, { diagnostic, held }] of read(witness).entries()) {
        if (!underBranch(branch.path, (diagnostic.data as { path?: unknown } | undefined)?.path)) continue;
        const configuration = space.existsDefinitions(space.and(held, present));
        if (configuration === FALSE) continue;
        const id = identityOf(diagnostic);
        const known = found.get(id);
        if (known && known.dead !== undefined) known.configuration = space.or(known.configuration, configuration);
        else if (!known) {
          found.set(id, { diagnostic, configuration, dead: { sentinel: branch.sentinel, branch: branch.branch }, order: [index, sequence++] });
        }
      }
    },
  );
  return [...found.values()]
    .sort((a, b) => a.order[0]! - b.order[0]! || a.order[1]! - b.order[1]!)
    .map(({ diagnostic, live, configuration, dead }) => ({
      diagnostic,
      definition,
      ...(live !== undefined ? { live } : {}),
      ...(dead ? { dead } : {}),
      configuration,
    }));
}
