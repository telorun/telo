/**
 * Name resolution over every configuration at once: what a name resolves to,
 * each outcome with the condition it holds under.
 *
 * Built once per analysis over the union's declarations. A lookup applies the
 * scoped rule of `ScopedNameResolver` — scope first, innermost out, then the
 * module: same module first, a name declared in exactly one module from
 * anywhere, a name declared in several others nothing — to the candidates of
 * the name, each present under its own condition, and answers every outcome
 * the presence of those candidates can give: resolved (to which declaration,
 * at which address), a stand-in, or unresolved. A lookup costs a pass over the
 * candidates of one name, so building every reference's answer is linear.
 *
 * A branch no configuration takes declares candidates too, under a FALSE
 * condition, so the outcomes over the space are unchanged by them; at a
 * witness forcing that branch (`locateAt` / `inModuleAt`) each candidate is
 * present as `takenAt` decides it — the one test of what a witness holds.
 *
 * Conditions stay here and in the driver: a builder asks the resolution seam
 * (`reference-resolution.ts`) and receives the one outcome holding where it is
 * asked.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isStandInDeclaration } from "./choice-expansion.js";
import {
  isAlternatives,
  takenAt,
  type ChoiceStep,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Witness,
} from "./conditioned-expansion.js";
import { isForwardedDeclaration, isForwardedExport } from "./forwarded-declaration.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { UNRESOLVED, type ResolutionOutcome } from "./reference-resolution.js";
import { scopeAddress, scopeSiteKey, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import { importPathOf } from "./scoped-name-resolver.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { parseKeys } from "./template-expansion.js";

/** The populations `!ref` resolution reads (`RefResolution`). */
export type NamePopulation = "local" | "exported" | "declared";

/** One outcome of a lookup and where it holds. */
export interface ConditionedOutcome {
  readonly outcome: ResolutionOutcome;
  readonly condition: Condition;
}

/** A declaration a name may resolve to, and where it is present: its
 *  condition, and the choices taken to declare it — how a forced witness
 *  decides it, a branch no configuration takes included. */
interface Candidate {
  readonly declaration: ResourceManifest;
  readonly condition: Condition;
  readonly path: readonly ChoiceStep[];
  readonly module: string | undefined;
}

/** The connectives the resolution rule is computed in. */
interface Logic<T> {
  readonly TRUE: T;
  readonly FALSE: T;
  and(a: T, b: T): T;
  or(a: T, b: T): T;
  not(a: T): T;
  isFalse(a: T): boolean;
}

/** An outcome's holding computed over the whole space and at one witness at
 *  once: its condition, and whether it holds there. */
interface Held {
  readonly condition: Condition;
  readonly at: boolean;
}

export class ConditionedNameIndex {
  /** The declarations some configuration holds at module level, by name. */
  private readonly moduleLevel = new Map<string, ConditionedDeclaration[]>();
  /** Every declaration at module level by name — one only a branch no
   *  configuration takes declares included, under its FALSE condition. */
  private readonly declared = new Map<string, ConditionedDeclaration[]>();
  /** Each scope's members by name, in written order, each with the condition
   *  it is declared under. */
  private readonly scopes = new Map<string, Map<string, Candidate[]>>();
  /** The union objects declaring each address, with their conditions. */
  private readonly holders = new Map<string, Candidate[]>();
  private readonly conditions: Logic<Condition>;

  /** The space every outcome's condition is in. */
  get space(): ConditionedExpansion["space"] {
    return this.union.space;
  }

  constructor(private readonly union: ConditionedExpansion) {
    const { space } = union;
    this.conditions = {
      TRUE,
      FALSE,
      and: (a, b) => space.and(a, b),
      or: (a, b) => space.or(a, b),
      not: (a) => space.not(a),
      isFalse: (a) => a === FALSE,
    };
    for (const declaration of union.declarations) {
      const name = declaration.manifest.metadata?.name;
      if (typeof name !== "string") continue;
      push(this.declared, name, declaration);
      if (!declaration.unreachable) push(this.moduleLevel, name, declaration);
      const module = moduleOf(declaration.manifest);
      const key = scopeAddress(module, name).key;
      this.holders.set(key, [
        ...(this.holders.get(key) ?? []),
        { declaration: declaration.manifest, condition: declaration.condition, path: declaration.path, module },
      ]);
    }
  }

  /** Every declaration of `name` some configuration holds at module level, in
   *  written order, each with the condition it is declared under. */
  declarationsNamed(name: string): readonly ConditionedDeclaration[] {
    return this.moduleLevel.get(name) ?? [];
  }

  /** Every name declared at module level. */
  names(): Iterable<string> {
    return this.moduleLevel.keys();
  }

  /** What `name`, read in `fromModule` inside `within`, resolves to among
   *  `population`, each outcome with where it holds. A scope declares only the
   *  analysed modules' own names. */
  locate(
    population: NamePopulation,
    name: string,
    fromModule: string | undefined,
    within?: ScopeSite,
  ): ConditionedOutcome[] {
    return this.located(this.conditions, (c) => c.condition, population, name, fromModule, within).map(
      ({ outcome, held }) => ({ outcome, condition: held }),
    );
  }

  /** The outcome of {@link locate} holding at `witness` — each candidate
   *  present as the witness takes the choices declaring it, a forced one by
   *  its forced branch — with its condition. */
  locateAt(
    population: NamePopulation,
    name: string,
    fromModule: string | undefined,
    within: ScopeSite | undefined,
    witness: Witness,
  ): ConditionedOutcome {
    const logic = this.heldAt(witness);
    return holding(this.located(logic.logic, logic.present, population, name, fromModule, within), name);
  }

  /** The module-level declaration of `name` by `module` itself among
   *  `population` — of the instance at `importPath` when the module is
   *  imported as several — each outcome with where it holds. */
  inModule(
    population: NamePopulation,
    name: string,
    module: string | undefined,
    importPath?: readonly string[],
  ): ConditionedOutcome[] {
    return this.inModuleBy(this.conditions, (c) => c.condition, population, name, module, importPath).map(
      ({ outcome, held }) => ({ outcome, condition: held }),
    );
  }

  /** The outcome of {@link inModule} holding at `witness`, with its condition. */
  inModuleAt(
    population: NamePopulation,
    name: string,
    module: string | undefined,
    importPath: readonly string[] | undefined,
    witness: Witness,
  ): ConditionedOutcome {
    const logic = this.heldAt(witness);
    return holding(this.inModuleBy(logic.logic, logic.present, population, name, module, importPath), name);
  }

  /** Whether {@link locate} answers one outcome at every witness, forced ones
   *  included: every candidate it reads is declared under no choice. */
  locateFixed(population: NamePopulation, name: string, within: ScopeSite | undefined): boolean {
    if (population === "local") {
      for (let site = within; site; site = site.holder.scope) {
        if (!(this.membersOf(site).get(name) ?? []).every(isFixed)) return false;
      }
    }
    return this.candidates(population, name).every(isFixed);
  }

  /** Whether {@link inModule} answers one outcome at every witness. */
  inModuleFixed(population: NamePopulation, name: string, module: string | undefined): boolean {
    return this.candidates(population, name)
      .filter((c) => c.module === module)
      .every(isFixed);
  }

  /** Conditions paired with whether each holds at `witness`. */
  private heldAt(witness: Witness): { logic: Logic<Held>; present: (c: Candidate) => Held } {
    const { space } = this.union;
    const logic: Logic<Held> = {
      TRUE: { condition: TRUE, at: true },
      FALSE: { condition: FALSE, at: false },
      and: (a, b) => ({ condition: space.and(a.condition, b.condition), at: a.at && b.at }),
      or: (a, b) => ({ condition: space.or(a.condition, b.condition), at: a.at || b.at }),
      not: (a) => ({ condition: space.not(a.condition), at: !a.at }),
      isFalse: (a) => a.condition === FALSE && !a.at,
    };
    const present = (c: Candidate): Held => ({
      condition: c.condition,
      at: takenAt(space, c.condition, c.path, witness.assignment, witness.forcing),
    });
    return { logic, present };
  }

  /** The scoped rule, computed in `logic` over each candidate's presence. */
  private located<T>(
    logic: Logic<T>,
    present: (c: Candidate) => T,
    population: NamePopulation,
    name: string,
    fromModule: string | undefined,
    within: ScopeSite | undefined,
  ): { outcome: ResolutionOutcome; held: T }[] {
    const out: { outcome: ResolutionOutcome; held: T }[] = [];
    // Where no scope of the chain has declared the name yet.
    let rest = logic.TRUE;
    if (population === "local") {
      for (let site = within; site; site = site.holder.scope) {
        const members = this.membersOf(site).get(name) ?? [];
        let earlier = logic.FALSE;
        for (const member of members) {
          const here = present(member);
          const first = logic.and(here, logic.not(earlier));
          earlier = logic.or(earlier, here);
          const held = logic.and(rest, first);
          if (!logic.isFalse(held)) out.push({ outcome: outcomeAt(member.declaration, scopeAddress(site, name)), held });
        }
        rest = logic.and(rest, logic.not(earlier));
        if (logic.isFalse(rest)) return out;
      }
    }
    const candidates = this.candidates(population, name);
    const presence = candidates.map(present);
    let resolved = logic.FALSE;
    candidates.forEach((candidate, i) => {
      // Alone: no other candidate present.
      let alone: T = presence[i]!;
      // Several present, this the first of the reader's module.
      let ownFirst: T = candidate.module === fromModule ? presence[i]! : logic.FALSE;
      let another = logic.FALSE;
      candidates.forEach((other, j) => {
        if (j === i) return;
        alone = logic.and(alone, logic.not(presence[j]!));
        another = logic.or(another, presence[j]!);
        if (j < i && other.module === fromModule) ownFirst = logic.and(ownFirst, logic.not(presence[j]!));
      });
      const held = logic.and(rest, logic.or(alone, logic.and(ownFirst, another)));
      resolved = logic.or(resolved, held);
      if (!logic.isFalse(held)) {
        out.push({ outcome: outcomeAt(candidate.declaration, scopeAddress(candidate.module, name)), held });
      }
    });
    const unresolved = logic.and(rest, logic.not(resolved));
    if (!logic.isFalse(unresolved)) out.push({ outcome: UNRESOLVED, held: unresolved });
    return out;
  }

  /** The module-level rule, computed in `logic` over each candidate's presence. */
  private inModuleBy<T>(
    logic: Logic<T>,
    present: (c: Candidate) => T,
    population: NamePopulation,
    name: string,
    module: string | undefined,
    importPath: readonly string[] | undefined,
  ): { outcome: ResolutionOutcome; held: T }[] {
    const candidates = this.candidates(population, name).filter((c) => c.module === module);
    const presence = candidates.map(present);
    const out: { outcome: ResolutionOutcome; held: T }[] = [];
    let resolved = logic.FALSE;
    candidates.forEach((candidate, i) => {
      let alone: T = presence[i]!;
      let firstPresent: T = presence[i]!;
      let firstOfPath: T = sameInstance(candidate.declaration, importPath) ? presence[i]! : logic.FALSE;
      let another = logic.FALSE;
      candidates.forEach((other, j) => {
        if (j === i) return;
        alone = logic.and(alone, logic.not(presence[j]!));
        another = logic.or(another, presence[j]!);
        if (j < i) firstPresent = logic.and(firstPresent, logic.not(presence[j]!));
        if (j < i && sameInstance(other.declaration, importPath)) {
          firstOfPath = logic.and(firstOfPath, logic.not(presence[j]!));
        }
      });
      const held = importPath === undefined ? firstPresent : logic.or(alone, logic.and(firstOfPath, another));
      resolved = logic.or(resolved, held);
      if (!logic.isFalse(held)) {
        out.push({ outcome: outcomeAt(candidate.declaration, scopeAddress(module, name)), held });
      }
    });
    const unresolved = logic.not(resolved);
    if (!logic.isFalse(unresolved)) out.push({ outcome: UNRESOLVED, held: unresolved });
    return out;
  }

  private candidates(population: NamePopulation, name: string): Candidate[] {
    const out: Candidate[] = [];
    for (const declaration of this.declared.get(name) ?? []) {
      const m = declaration.manifest;
      if (isKindDocumentOrImport(m)) continue;
      if (population === "local" && isForwardedDeclaration(m)) continue;
      if (population === "exported" && !isForwardedExport(m)) continue;
      out.push({ declaration: m, condition: declaration.condition, path: declaration.path, module: moduleOf(m) });
    }
    return out;
  }

  /** The members `site` declares, read off every union object holding its
   *  holder's address. */
  private membersOf(site: ScopeSite): Map<string, Candidate[]> {
    const key = scopeSiteKey(site);
    const known = this.scopes.get(key);
    if (known) return known;
    const members = new Map<string, Candidate[]>();
    this.scopes.set(key, members);
    const { space } = this.union;
    // A member is present where every option enclosing it is taken: an
    // option's path runs from the document's root, so the innermost one's is
    // the member's. A branch no configuration takes declares members too.
    const add = (value: unknown, condition: Condition, path: readonly ChoiceStep[]): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          if (!option.present) continue;
          add(option.value, space.and(condition, option.condition), option.path);
        }
        return;
      }
      if (Array.isArray(value)) for (const item of value) addMember(item, condition, path);
    };
    const addMember = (item: unknown, condition: Condition, path: readonly ChoiceStep[]): void => {
      if (isAlternatives(item)) {
        for (const option of item.options) {
          if (!option.present) continue;
          addMember(option.value, space.and(condition, option.condition), option.path);
        }
        return;
      }
      const name = (item as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (!item || typeof item !== "object" || typeof name !== "string") return;
      const declaration = item as ResourceManifest;
      const address = scopeAddress(site, name).key;
      const candidate: Candidate = { declaration, condition, path, module: site.holder.module };
      this.holders.set(address, [...(this.holders.get(address) ?? []), candidate]);
      const list = members.get(name);
      if (list) list.push(candidate);
      else members.set(name, [candidate]);
    };
    if (site.holder.scope) this.membersOf(site.holder.scope);
    const keys = parseKeys(site.field);
    const visit = (at: unknown, depth: number, condition: Condition, path: readonly ChoiceStep[]): void => {
      if (isAlternatives(at)) {
        for (const option of at.options) {
          if (!option.present) continue;
          visit(option.value, depth, space.and(condition, option.condition), option.path);
        }
        return;
      }
      if (depth === keys.length) {
        add(at, condition, path);
        return;
      }
      if (at === null || typeof at !== "object") return;
      visit((at as Record<string | number, unknown>)[keys[depth] as string], depth + 1, condition, path);
    };
    for (const holder of this.holders.get(site.holder.key) ?? []) {
      visit(holder.declaration, 0, holder.condition, holder.path);
    }
    return members;
  }
}

/** A candidate no choice declares: present at every witness, forced or not. */
function isFixed(candidate: Candidate): boolean {
  return candidate.condition === TRUE && candidate.path.length === 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The one outcome holding at a witness: the outcomes partition every
 *  configuration, and a forced one too. */
function holding(outcomes: readonly { outcome: ResolutionOutcome; held: Held }[], name: string): ConditionedOutcome {
  const found = outcomes.find((o) => o.held.at);
  if (!found) throw new Error(`internal: no outcome of the name '${name}' holds at its witness.`);
  return { outcome: found.outcome, condition: found.held.condition };
}

function moduleOf(m: ResourceManifest): string | undefined {
  return (m.metadata as { module?: string } | undefined)?.module;
}

function sameInstance(declaration: ResourceManifest, importPath: readonly string[] | undefined): boolean {
  if (importPath === undefined) return false;
  const path = importPathOf(declaration);
  return path !== undefined && path.length === importPath.length && path.every((segment, i) => segment === importPath[i]);
}

function outcomeAt(declaration: ResourceManifest, address: ScopeAddress): ResolutionOutcome {
  return { status: isStandInDeclaration(declaration) ? "stand-in" : "resolved", declaration, address };
}
