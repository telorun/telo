/**
 * Scope members over every configuration at once: two members of one scope
 * sharing a name, and a sink declared in a scope, which no list can attach.
 * Each scope is read once per distinct set of members the fields declaring it
 * hold — what each member holds beside its identity is not read — never once
 * per configuration, and each finding is held in the raw form a
 * configuration run's own would take — already moved onto the member's place
 * in its holder, which the union world's placement could not.
 *
 * Browser-safe.
 */
import { Placement } from "./placement.js";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import { isAlternatives, takenAt, type ConditionedDeclaration, type ConditionedExpansion, World } from "./conditioned-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { analysisOrder, type KeyParts, type RegionPart } from "./key-parts.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import type { NestedPlaces } from "./own-check-sites.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { isAtOrAbove } from "./relation-sites.js";
import { placeByUnionKeys } from "./region-part.js";
import { scopeSiteKey } from "./scope-address.js";
import { ScopeMembers, type ScopeMember } from "./scope-members.js";
import type { AnalysisDiagnostic } from "./types.js";
import { holdsChoice } from "./key-door.js";
import { isKindDocument } from "./kind-declaration.js";
import { reportDocumentStage } from "./cel-site-judgements.js";
import { TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import type { SchemaValidationOutcome } from "./schema-validation.js";
import { validateScopedKindMembers, type KindDocumentKind } from "./validate-scoped-kind-documents.js";
import { duplicateNameDiagnostic } from "./validate-references.js";
import { scopeArrayNameCollisions } from "./validate-scoped-imports.js";
import { sinkUnattachedDiagnostic } from "./validate-sink-attachment.js";
import { fixedFindings, readDeadBranches, type PassTable } from "./union-passes.js";
import type { DeadBranchRun } from "./world-reader.js";

type Keys = readonly (string | number)[];

export interface ScopeMemberInputs {
  readonly union: ConditionedExpansion;
  readonly parts: KeyParts;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly rootModules: ReadonlySet<string>;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver> | undefined;
  /** The fields a declaration of `holder`'s kind declares a scope at. */
  scopeFieldsOf(holder: { readonly kind: unknown; readonly metadata: unknown }): readonly string[];
  /** How the runs judge the objects written beneath `declaration`. */
  nestedOf(declaration: ConditionedDeclaration): NestedPlaces;
  /** A kind document's findings against its built-in entry's schema. */
  validateKindDocument(member: ResourceManifest, kind: KindDocumentKind): SchemaValidationOutcome;
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** One finding held where `condition` does, at its place in a run's order. */
interface Entry {
  readonly diagnostic: AnalysisDiagnostic;
  readonly condition: Condition;
  readonly holder: ResourceManifest;
  readonly index: number;
}

/** Where a declaration holds scopes of its own: the object declaring them, by
 *  union keys, and the fields. */
interface ScopeHolder {
  readonly declaration: ConditionedDeclaration;
  readonly fields: readonly Keys[];
}

export function scopeMemberFindings(inputs: ScopeMemberInputs): {
  readonly duplicates: PassTable;
  readonly sinks: PassTable;
  readonly kindDocuments: PassTable;
} {
  const { union, parts, universe, rootModules, defs, aliases, aliasesByModule } = inputs;
  const { space } = union;
  const moduleDocNames = new Set<string>();
  for (const { manifest } of union.declarations) {
    if (isModuleKind(manifest.kind) && typeof manifest.metadata?.name === "string") moduleDocNames.add(manifest.metadata.name);
  }

  // Every object of a declaration that declares a scope and that a run analyses
  // as a declaration: the declaration itself, and one extraction draws out of
  // it, unless a scope of another one already holds it.
  const holders: ScopeHolder[] = [];
  for (const declaration of union.declarations) {
    const found: { keys: Keys; fields: Keys[]; record: object }[] = [];
    const visit = (value: unknown, keys: Keys): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) if (option.present) visit(option.value, keys);
        return;
      }
      if (!value || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...keys, i]));
        return;
      }
      const record = value as Record<string, unknown>;
      if (keys.length > 0 && isKindDocument(record)) {
        const varies = Object.entries(record).some(
          ([key, field]) => !(record.kind === "Telo.Definition" && TEMPLATE_BODY_FIELDS.includes(key)) && holdsChoice(field),
        );
        if (varies) {
          throw new Error(`internal: the scoped kind document ${String(record.kind)} '${String((record.metadata as { name?: unknown } | undefined)?.name)}' varies between configurations.`);
        }
      }
      if (typeof record.kind === "string") {
        const fields = inputs.scopeFieldsOf({ kind: record.kind, metadata: keys.length === 0 ? record.metadata : declaration.manifest.metadata });
        const held = fields.filter((field) => record[field] !== undefined).map((field) => [...keys, field]);
        if (held.length > 0) found.push({ keys, fields: held, record });
      }
      for (const [key, field] of Object.entries(record)) visit(field, [...keys, key]);
    };
    visit(declaration.manifest, []);
    let nested: NestedPlaces | undefined;
    for (const { keys, fields, record } of found) {
      if (keys.length > 0) {
        // A member of another holder's scope is that scope's to read.
        if (found.some((other) => other.fields.some((f) => isAtOrAbove(f, keys)))) continue;
        nested ??= inputs.nestedOf(declaration);
        if (nested.of(record) !== "extracted") continue;
      }
      holders.push({ declaration, fields });
    }
  }
  if (holders.length === 0) {
    const none: PassTable = { found: [], dead: [] };
    return { duplicates: none, sinks: none, kindDocuments: none };
  }

  /** What `region` finds of its scope members, in a run's order and raw form. */
  const findingsOf = (region: RegionPart) => {
    const relocator = new ScopeMembers([...region.members, ...region.kindMembers]);
    const relocated = (d: AnalysisDiagnostic) => new Placement({ scopeMembers: relocator }).place([d])[0]!;
    const duplicates: { diagnostic: AnalysisDiagnostic; holder: ResourceManifest; index: number }[] = [];
    const sinks: { diagnostic: AnalysisDiagnostic; holder: ResourceManifest; index: number }[] = [];
    const kindDocuments: { diagnostic: AnalysisDiagnostic; holder: ResourceManifest; index: number }[] = [];
    if (region.kindMembers.length > 0) {
      reportDocumentStage("scopedKindDocuments", false);
      region.kindMembers.forEach((member, index) => {
        for (const found of validateScopedKindMembers([member], rootModules, inputs.validateKindDocument)) {
          kindDocuments.push({ diagnostic: relocated(found), holder: holderOf(region, member), index });
        }
      });
    }
    const byScope = new Map<string, { first: number; members: Map<string, { member: ScopeMember; index: number }[]> }>();
    region.members.forEach((member, index) => {
      const m = member.declaration;
      const name = m.metadata?.name;
      const module = (m.metadata as { module?: string } | undefined)?.module;
      // Two members of one scope sharing a name — a dependency's scope is its
      // own author's.
      if (
        typeof name === "string" &&
        !isForwardedDeclaration(m) &&
        !(m.metadata as { xTeloChoice?: unknown }).xTeloChoice &&
        !(module !== undefined && module !== "" && moduleDocNames.size > 0 && !moduleDocNames.has(module))
      ) {
        const key = scopeSiteKey(member.site);
        let scope = byScope.get(key);
        if (!scope) byScope.set(key, (scope = { first: index, members: new Map() }));
        const list = scope.members.get(name) ?? [];
        list.push({ member, index });
        scope.members.set(name, list);
      }
      // A sink no list can name, of the entry's own modules.
      if (typeof m.kind !== "string" || (module !== undefined && !rootModules.has(module))) return;
      const canonical = moduleAliasScope(m.metadata, aliases, aliasesByModule).resolveKind(m.kind) ?? m.kind;
      const definition = defs.resolve(canonical);
      if (definition?.kind === "Telo.Abstract" || definition?.capability !== "Telo.Sink" || typeof name !== "string") return;
      sinks.push({ diagnostic: relocated(sinkUnattachedDiagnostic(m, true)), holder: holderOf(region, member), index });
    });
    // A name two scope arrays of one holder share.
    region.manifests.forEach((holder, index) => {
      for (const found of scopeArrayNameCollisions(holder, rootModules)) {
        duplicates.push({ diagnostic: relocated(found), holder: region.manifests[0]!, index });
      }
    });
    for (const scope of byScope.values()) {
      for (const [name, list] of scope.members) {
        const [first, ...rest] = list;
        for (const dup of rest) {
          const found = duplicateNameDiagnostic(dup.member.declaration, first!.member.declaration, name);
          if (found) duplicates.push({ diagnostic: relocated(found), holder: holderOf(region, first!.member), index: scope.first });
        }
      }
    }
    return { duplicates, sinks, kindDocuments };
  };

  /** Whether `value` holds, at any depth and in any option, an object with a
   *  `kind`: a declaration, which may be a scope member or join one. */
  const declares = new WeakMap<object, boolean>();
  const holdsDeclaration = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return false;
    const known = declares.get(value);
    if (known !== undefined) return known;
    declares.set(value, false);
    const found = isAlternatives(value)
      ? value.options.some((option) => holdsDeclaration(option.value))
      : (!Array.isArray(value) && typeof (value as Record<string, unknown>).kind === "string") ||
        (Array.isArray(value) ? value : Object.values(value)).some(holdsDeclaration);
    declares.set(value, found);
    return found;
  };
  /** The condition under which the members a scope field holds read alike at
   *  every configuration as at `witness`: the choices deciding which
   *  declarations are written there, where, and as what — their `kind` and
   *  `metadata` — and none of what each holds beside them. */
  const membersTaken = (value: unknown, witness: World, identity: boolean): Condition => {
    if (isAlternatives(value)) {
      const option = value.options.find((each) =>
        takenAt(space, each.condition, each.path, witness.assignment, witness.forcing),
      );
      if (!option) return FALSE;
      const inner = option.present ? membersTaken(option.value, witness, identity) : TRUE;
      return identity || value.options.some((each) => holdsDeclaration(each.value)) ? space.and(option.condition, inner) : inner;
    }
    if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return TRUE;
    if (!identity && !holdsDeclaration(value)) return TRUE;
    let condition = TRUE;
    if (Array.isArray(value)) {
      for (const item of value) condition = space.and(condition, membersTaken(item, witness, identity));
      return condition;
    }
    const declaration = typeof (value as Record<string, unknown>).kind === "string";
    for (const [key, field] of Object.entries(value)) {
      condition = space.and(condition, membersTaken(field, witness, identity || (declaration && (key === "kind" || key === "metadata"))));
    }
    return condition;
  };

  /** The holder's scope fields at `witness`: those present, and the condition
   *  under which every configuration reads their members alike. A reference a
   *  member holds is no member, so what it resolves to is not read. */
  const fieldsAt = (holder: ScopeHolder, witness: World) => {
    let condition = TRUE;
    const present: Keys[] = [];
    for (const keys of holder.fields) {
      const place = placeByUnionKeys(union, holder.declaration, keys, witness);
      condition = space.and(condition, place.path);
      if (!place.present) continue;
      present.push(keys);
      condition = space.and(condition, space.and(place.position, membersTaken(place.node, witness, false)));
    }
    return { condition, present };
  };

  const duplicates: Entry[] = [];
  const sinks: Entry[] = [];
  const kindDocuments: Entry[] = [];
  for (const holder of holders) {
    let remaining = space.and(holder.declaration.condition, universe);
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      const fields = fieldsAt(holder, witness);
      reportKeyCost({ kind: "pass-reading", pass: "scopeMembers", declaration: holder.declaration });
      let condition = space.and(holder.declaration.condition, fields.condition);
      if (fields.present.length > 0) {
        const found = findingsOf(parts.regionsAt(holder.declaration, fields.present, witness));
        for (const each of found.duplicates) duplicates.push({ ...each, condition });
        for (const each of found.sinks) sinks.push({ ...each, condition });
        for (const each of found.kindDocuments) kindDocuments.push({ ...each, condition });
      }
      if (!space.holds(condition, witness.assignment)) {
        throw new Error(`internal: a scope reading of ${holder.declaration.manifest.kind}/${holder.declaration.manifest.metadata?.name} does not hold where it was read.`);
      }
      remaining = space.and(remaining, space.not(condition));
    }
  }
  const byOrder = (a: { holder: ResourceManifest; index: number }, b: { holder: ResourceManifest; index: number }) =>
    (a.holder === b.holder ? 0 : analysisOrder(a.holder, b.holder)) || a.index - b.index;

  // Each branch no configuration takes: read once, at its baseline with its forcing.
  const dead = new Map(inputs.deadBranches.map((branch) => {
    const witness: World = branch.world;
    const found = { duplicates: [] as Entry[], sinks: [] as Entry[], kindDocuments: [] as Entry[] };
    for (const holder of holders) {
      if (!parts.presentAt(holder.declaration, witness)) continue;
      const fields = fieldsAt(holder, witness);
      if (fields.present.length === 0) continue;
      const read = findingsOf(parts.regionsAt(holder.declaration, fields.present, witness));
      for (const each of read.duplicates) found.duplicates.push({ ...each, condition: TRUE });
      for (const each of read.sinks) found.sinks.push({ ...each, condition: TRUE });
      for (const each of read.kindDocuments) found.kindDocuments.push({ ...each, condition: TRUE });
    }
    return [branch, found] as const;
  }));
  const passOf = { duplicates: "scopedDuplicates", sinks: "scopedSinks", kindDocuments: "scopedKindDocuments" } as const;
  const tableOf = (family: "duplicates" | "sinks" | "kindDocuments", entries: Entry[]): PassTable => ({
    found: fixedFindings(entries.sort(byOrder)),
    dead: readDeadBranches(passOf[family], inputs.deadBranches, (branch) =>
      dead.get(branch)![family].sort(byOrder).map((entry) => ({ branch, render: () => [entry.diagnostic] })),
    ),
  });
  return { duplicates: tableOf("duplicates", duplicates), sinks: tableOf("sinks", sinks), kindDocuments: tableOf("kindDocuments", kindDocuments) };
}

/** Where a member's findings stand among a run's: after every holder before
 *  the one its scope is declared on at the top of the region. */
function holderOf(region: RegionPart, member: ScopeMember): ResourceManifest {
  let holder = member.holder;
  for (let next = region.members.find((m) => m.declaration === holder); next; next = region.members.find((m) => m.declaration === holder)) {
    holder = next.holder;
  }
  return holder;
}
