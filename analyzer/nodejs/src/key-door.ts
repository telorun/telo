/**
 * The DOOR: how a key's environment answers the requests of the builders that
 * judge one CEL site — the only way a fact that depends on a configuration
 * reaches the judgement.
 *
 * A key's environment holds the site's own declaration projected at the key's
 * witness and every declaration its classes cover, each normalized there
 * (`key-parts.ts`), over the shared layer of the declarations no configuration
 * the key is judged for varies (`doorCare`): the kept configurations for a key
 * some configuration holds — its care set — and the whole space for a key a
 * branch no configuration takes reads. The door answers a request from those
 * two layers, and only where the key's classes say the answer is the same
 * wherever the key holds:
 *  - **by name** — answered when every declaration of the name is invariant,
 *    out of view or the site's own, when a class covers the name whole, when a
 *    read by name holds every declaration of it as the places its reader reads,
 *    or when one covers both what a reference to it resolves to and the region
 *    read there. A name no declaration present at the witness answers to is
 *    answered absent only under the presence class. Anything else is refused.
 *  - **named enumeration** — answered when no declaration the key does not
 *    cover could join the set, or from the class covering it; otherwise refused.
 *
 * A refusal is an internal error naming the site and the request: a read the
 * key does not capture, which would otherwise be a verdict over what some other
 * configuration happens to hold.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { KeyCoverage } from "./cel-site-solve.js";
import {
  isAlternatives,
  takenAt,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Witness,
} from "./conditioned-expansion.js";
import type { ChoiceReading, StandInConstruct } from "./choice-reading.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import type { DeclarationRequests, NameRequests, ReferringSlot } from "./declaration-requests.js";
import type { DecidedInput, InputNarrowing } from "./kernel-globals.js";
import { isKindDocument } from "./kind-declaration.js";
import { analysisOrder, type SharedLayer } from "./key-parts.js";
import { resolutionOver, type NameResolution } from "./reference-resolution.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import type { ScopedNameResolver } from "./scoped-name-resolver.js";

/** A request a key's door cannot answer: a read no class of the key covers. */
export class DoorRefusal extends Error {
  constructor(site: string, request: string) {
    super(`internal: the environment of CEL site ${site} was asked ${request}, which no class of its key covers.`);
    this.name = "DoorRefusal";
  }
}

/** Whether a value of the union holds a choice anywhere inside it. */
export function holdsChoice(value: unknown): boolean {
  if (isAlternatives(value)) return true;
  if (value === null || typeof value !== "object") return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsChoice);
}

/** The declarations of the union no configuration varies: declared in every
 *  configuration, with no choice inside. */
export function invariantDeclarations(union: ConditionedExpansion): ReadonlySet<ConditionedDeclaration> {
  const out = new Set<ConditionedDeclaration>();
  for (const declaration of union.declarations) {
    if (declaration.condition === TRUE && !holdsChoice(declaration.manifest)) out.add(declaration);
  }
  return out;
}

/**
 * What a key's door holds fixed, read over the configurations the key is
 * judged for: the declarations and forward views the same in every one of
 * them, and the declarations none of them holds.
 */
export interface DoorCare {
  readonly invariant: ReadonlySet<ConditionedDeclaration>;
  readonly outOfView: ReadonlySet<ConditionedDeclaration>;
}

/**
 * The door's care over `care`, the configurations kept: a declaration or view
 * declared throughout them whose every choice takes one option throughout them
 * is invariant, one declared in none of them is out of view. Without `care`,
 * the whole space a branch no configuration takes is read in: a declaration is
 * invariant only where no choice is written in it, and none is out of view.
 */
export function doorCare(union: ConditionedExpansion, care?: Condition): DoorCare {
  if (care === undefined) return { invariant: invariantDeclarations(union), outOfView: new Set() };
  const { space } = union;
  const decided = (value: unknown): boolean => {
    if (isAlternatives(value)) {
      const option = value.options.find((each) => space.implies(care, each.condition));
      return option !== undefined && (!option.present || decided(option.value));
    }
    if (value === null || typeof value !== "object") return true;
    return (Array.isArray(value) ? value : Object.values(value)).every(decided);
  };
  const invariant = new Set<ConditionedDeclaration>();
  const outOfView = new Set<ConditionedDeclaration>();
  for (const declaration of [...union.declarations, ...union.views]) {
    if (space.and(declaration.condition, care) === FALSE) outOfView.add(declaration);
    else if (space.implies(care, declaration.condition) && decided(declaration.manifest)) invariant.add(declaration);
  }
  return { invariant, outOfView };
}

/** What one key's door reads: the union, its witness, and what it covers. */
export interface DoorScope {
  /** The site the environment judges, for a refusal to name. */
  readonly site: string;
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  readonly witness: Witness;
  readonly coverage: KeyCoverage;
  /** What the door holds fixed at the witness. */
  readonly care: DoorCare;
  /** The site's own declaration. */
  readonly own?: ConditionedDeclaration;
}

/** Whether every declaration the door holds stands for a configuration the key
 *  holds in, beside the site's own: each declaration of the union the door
 *  does not hold whole is invariant or out of view — one it holds only as the
 *  regions a reference reads is not. */
function coversEverything(scope: DoorScope): boolean {
  return scope.union.declarations.every((d) => {
    const name = d.manifest.metadata?.name;
    return (
      d.unreachable ||
      d === scope.own ||
      scope.care.invariant.has(d) ||
      scope.care.outOfView.has(d) ||
      (typeof name === "string" && scope.coverage.names.has(name))
    );
  });
}

function coversName(scope: DoorScope, name: unknown): boolean {
  if (typeof name !== "string") return false;
  const { coverage } = scope;
  if (coverage.names.has(name) || coverage.named.has(name)) return true;
  // A declaration a reference resolves to, held as the regions read in it.
  return coverage.outcomes.has(name) && [...coverage.parts.keys()].some((d) => d.manifest.metadata?.name === name);
}

/** Whether the door answers a by-name request for `name`. */
export function answersName(scope: DoorScope, name: string): boolean {
  const declared = scope.names.declarationsNamed(name);
  if (declared.every((d) => d === scope.own || scope.care.invariant.has(d) || scope.care.outOfView.has(d))) return true;
  if (coversName(scope, name)) return true;
  // Absent wherever the key holds: the presence class says so.
  const { space } = scope.union;
  const { assignment, forcing } = scope.witness;
  return scope.coverage.presence && declared.every((d) => !takenAt(space, d.condition, d.path, assignment, forcing));
}

/** Whether the key holds the content of the declarations named `name` — what a
 *  `resources` record lists as an entry holding no member where it does not,
 *  and what the exit audit refuses a read of. The one test of both: an inert
 *  entry is known by this, never by its node's shape. */
export function holdsContentOf(scope: DoorScope, name: string): boolean {
  return answersName({ ...scope, coverage: { ...scope.coverage, presence: false } }, name);
}

function guardName(scope: DoorScope, name: string, request: string): void {
  if (!answersName(scope, name)) throw new DoorRefusal(scope.site, `${request} '${name}'`);
}

/** What one key's environment holds: its own declarations, normalized, over
 *  the shared layer every key reads beneath them (`key-parts.ts`). */
export interface DoorLayers {
  /** The key's own manifests, in analysis order. */
  readonly own: readonly ResourceManifest[];
  /** Name resolution over both layers. */
  readonly names: ScopedNameResolver<ResourceManifest>;
  readonly shared: SharedLayer;
}

const sharedKinds = new WeakMap<SharedLayer, { list: readonly ResourceManifest[]; held: ReadonlySet<ResourceManifest> }>();

/** The kind documents of a shared layer, listed once. */
function sharedKindDocuments(shared: SharedLayer): { list: readonly ResourceManifest[]; held: ReadonlySet<ResourceManifest> } {
  let known = sharedKinds.get(shared);
  if (!known) {
    const list = shared.manifests.filter((m) => isKindDocument(m));
    sharedKinds.set(shared, (known = { list, held: new Set(shared.manifests) }));
  }
  return known;
}

/** Every manifest of both layers, in analysis order — for a request reading
 *  the whole application. */
function everything(layers: DoorLayers): readonly ResourceManifest[] {
  const own = new Set(layers.own);
  return [...layers.own, ...layers.shared.manifests.filter((m) => !own.has(m))].sort(analysisOrder);
}

/** The by-name requests over both layers, each refused for a name the door
 *  does not answer. A scope member is read inside the declaration holding it,
 *  so it is answered from that declaration. */
function doorNames(layers: DoorLayers, scope: DoorScope): NameRequests {
  const inner = layers.names;
  return {
    resolve: (name, fromModule, within, accept) => {
      if (!inner.scopeMember(name, within)) guardName(scope, name, "for the declaration named");
      return inner.resolve(name, fromModule, within, accept);
    },
    locate: (name, fromModule, within, accept) => {
      if (!inner.scopeMember(name, within)) guardName(scope, name, "for the declaration named");
      return inner.locate(name, fromModule, within, accept);
    },
    scopeMember: (name, within) => inner.scopeMember(name, within),
    declarationsOf: (name) => {
      guardName(scope, name, "for every declaration named");
      return inner.declarationsOf(name);
    },
    inModule: (name, module, importPath) => {
      guardName(scope, name, "for the declaration of a module named");
      return inner.inModule(name, module, importPath);
    },
  };
}

/**
 * Every request a key's environment answers. `referrers` answers the slots
 * referencing a declaration, over the manifests it is given. An enumeration a
 * builder reads per key — what `resources` publishes, the callables — is the
 * key's own declarations, the shared layer standing beneath a lookup by name;
 * one reading the whole application — a catch ladder, the referrers — is both
 * layers, and only where the key's classes cover it.
 */
export function doorRequests(
  layers: DoorLayers,
  scope: DoorScope,
  referrers: (all: readonly ResourceManifest[], m: ResourceManifest) => readonly ReferringSlot[],
  /** Whether a module document varies outside its `targets:`. */
  moduleDocumentsVary: boolean,
  /** What the module documents request answers: each declaring module's
   *  shared globals base, or — read whole — the module documents the key holds. */
  moduleDocuments: readonly ResourceManifest[],
): DeclarationRequests {
  const names = doorNames(layers, scope);
  let kinds: readonly ResourceManifest[] | undefined;
  let all: readonly ResourceManifest[] | undefined;
  const whole = () => (all ??= everything(layers));
  return {
    names,
    kindDocuments: () => {
      if (kinds) return kinds;
      const shared = sharedKindDocuments(layers.shared);
      const extra = layers.own.filter((m) => isKindDocument(m) && !shared.held.has(m));
      kinds = extra.length === 0 ? shared.list : [...shared.list, ...extra].sort(analysisOrder);
      return kinds;
    },
    moduleDocuments: () => {
      if (moduleDocumentsVary) throw new DoorRefusal(scope.site, "for the module documents, one of which a choice varies");
      return moduleDocuments;
    },
    published: () => layers.own,
    callables: () => layers.own,
    catchScope: () => {
      if (!coversEverything(scope)) throw new DoorRefusal(scope.site, "for every declaration a catch ladder reads");
      return whole();
    },
    referrersOf: (m) => {
      const name = m.metadata?.name;
      if (!(typeof name === "string" && scope.coverage.referrers.has(name)) && !coversEverything(scope)) {
        throw new DoorRefusal(scope.site, `for the declarations referencing '${String(name)}'`);
      }
      return referrers(whole(), m);
    },
    holdsContentOf: (m) => {
      const name = m.metadata?.name;
      return typeof name !== "string" || holdsContentOf(scope, name);
    },
  };
}

/** The resolution seam a builder reading through a reference asks — the
 *  consumer expander's `declarationAt`, a forward view's `fromSelf` — answered
 *  over both layers and refused for a name the door does not answer. */
export function doorResolution(layers: DoorLayers, scope: DoorScope): NameResolution {
  const inner = resolutionOver(layers.names);
  return {
    locate: (name, fromModule, within, accept) => {
      guardName(scope, name, "for what a reference resolves to, named");
      return inner.locate(name, fromModule, within, accept);
    },
    inModule: (name, module, importPath) => {
      guardName(scope, name, "for what a reference resolves to, named");
      return inner.inModule(name, module, importPath);
    },
    declareScope: (site, members) => inner.declareScope(site, members),
  };
}

/** What a witness decides of each module's inputs, for typing: its baseline's.
 *  Forcing takes a branch and decides no input. */
export function narrowingAt(choices: ChoiceReading, witness: Witness): InputNarrowing {
  return choices.narrowing(witness.assignment);
}

/** The inputs a key's expressions read: each block read whole, and each entry
 *  read by name (`variables.flag`, `resources.databaseAccess`). */
export interface InputReads {
  readonly whole: ReadonlySet<string>;
  readonly entries: ReadonlySet<string>;
}

/** `narrowing` holding only the entries `reads` names: what a key's classes
 *  narrow, laid over its module's globals base. */
export function narrowingOfReads(narrowing: InputNarrowing, reads: InputReads): InputNarrowing {
  const read = (chain: string): boolean => {
    const [block, name] = chain.split(".");
    return reads.whole.has(block!) || reads.entries.has(`${block}.${name}`);
  };
  const entries = (block: string, decided: ReadonlyMap<string, DecidedInput>) =>
    new Map([...decided].filter(([name]) => read(`${block}.${name}`)));
  return (module, importPath) => {
    const decided = narrowing(module, importPath);
    if (!decided) return undefined;
    return {
      variables: entries("variables", decided.variables),
      secrets: entries("secrets", decided.secrets),
      ...(decided.chains ? { chains: new Map([...decided.chains].filter(([chain]) => read(chain))) } : {}),
      ...(decided.present ? { present: new Set([...decided.present].filter(read)) } : {}),
      ...(decided.needs ? { needs: new Map([...decided.needs].filter(([need]) => read(`resources.${need}`))) } : {}),
    };
  };
}

/** The choices a witness expands to a stand-in: its baseline's, a forced
 *  choice by the branch it is forced to. */
export function standInsAt(choices: ChoiceReading, witness: Witness): readonly StandInConstruct[] {
  return choices.standIns(witness.assignment, witness.forcing);
}

/** The value of `source`, written in `holder`, at a witness: over its
 *  baseline's inputs, which forcing leaves as they are. */
export function valueInAt(
  choices: ChoiceReading,
  witness: Witness,
): (holder: ResourceManifest, source: string) => { value: unknown } | undefined {
  return (holder, source) => choices.valueIn(holder, source, witness.assignment);
}
