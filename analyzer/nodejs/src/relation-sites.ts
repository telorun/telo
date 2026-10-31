/**
 * RELATION SITES: the own checks relating parts of a declaration, each judged
 * per INSTANCE. An instance is an ANCHOR — a written place of the union — plus
 * what it reads: places of its declaration and classes outside it. An instance
 * exists exactly where its anchor's written place exists; whatever a reader
 * consults to decide whether or how to judge is a read, never a reason to
 * drop the anchor.
 *
 * Each relational group registers one reader of three members:
 *
 *  - `instances(region, scope)` — the instances whose anchors lie at or
 *    beneath a normalized region's root, read off the region and the
 *    registries, whose kinds never vary;
 *  - `reads(instance, region, scope)` — the declaration's places it reads and
 *    the classes it reads outside the declaration: the places it reads in
 *    the declarations its references reach, what its expressions were typed
 *    as, the results of the steps it reads, the scopes its names resolve in,
 *    and what encloses it — and what it reads depending on what its places
 *    hold;
 *  - `judge(instance, input)` — the group's rule over that one instance: its
 *    anchor region normalized, the declaration's identity, and the door, whose
 *    BY-PLACE request answers only the declared read places and whose other
 *    requests answer only what the reads declare.
 *
 * The table of readers is exhaustive over the groups, so a group with no
 * reader does not compile.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { ModuleCallDispatch } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DeclarationRequests } from "./declaration-requests.js";
import type { DeclaredDefinition } from "./declared-definition.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { LibraryDeclarations } from "./library-declarations.js";
import type { InputNarrowing } from "./kernel-globals.js";
import type { ReferentReads } from "./read-place.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { ShapeAwareValidator } from "./validate-value-schema.js";

type Keys = readonly (string | number)[];

/** The groups of a declaration's own checks, each judged outside a
 *  configuration run and placed where its pass stands in one. */
export type OwnGroup =
  | "schema"
  | "identifiers"
  | "nested"
  | "templateTargets"
  | "contracts"
  | "unboundCalls"
  | "referenceOutputs"
  | "slotInputs"
  | "stepInputs"
  | "bindings"
  | "accessors"
  | "browserExports"
  | "computedRefSlots"
  | "annotations"
  | "match"
  | "slotFitOwn"
  | "slotFitTemplate"
  | "slotFitCalls"
  | "resourceRules";

/** The groups of the schema family: each judged at the sites a declaration's
 *  schema checks are cut into. */
export type SchemaGroup = "schema" | "identifiers";

/** The groups relating a declaration's parts. */
export type RelationalGroup = Exclude<OwnGroup, SchemaGroup>;

/** Who a region belongs to: the declaration's `kind` and `metadata`, an
 *  implicit read of every region. */
export interface DeclarationIdentity {
  /** Marks the identity apart from a declaration, which it never stands for. */
  readonly identityOnly: true;
  readonly kind: string;
  readonly metadata: Record<string, unknown>;
}

/** A normalized region: its root's projected place in the declaration and the
 *  value there, with what normalization drew out of it. */
export interface RelationRegion {
  readonly identity: DeclarationIdentity;
  /** The region root's projected keys in its declaration. */
  readonly at: Keys;
  /** The value at a place at or beneath the root; undefined elsewhere. */
  valueAt(keys: Keys): unknown;
  /** The manifest holding the region: the declaration's `kind` and `metadata`,
   *  the way to the root and the region — what a reader walking the kind's
   *  schema from the root walks, reporting only the anchors at or beneath it. */
  readonly holder: unknown;
}

/** What a reader's structural walk reads beside a region: the registries,
 *  whose kinds never vary. */
export interface RelationReaderScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly libraries: LibraryDeclarations | undefined;
  /** Which definition the declaration `identity` names is judged against. */
  declared(identity: DeclarationIdentity): DeclaredDefinition;
  /** The names a CEL call's receiver may be in the module `identity` is
   *  declared in. */
  moduleNames(identity: DeclarationIdentity): ReadonlySet<string>;
}

/** One relation the group judges: its anchor's projected keys, and the places
 *  of its declaration the reader found it relates the anchor to. */
export interface RelationInstance {
  readonly anchor: Keys;
  readonly related?: readonly Keys[];
}

/**
 * A reference a rule follows, written at `at` (projected keys of its
 * declaration): in each declaration it reaches, its identity and the places
 * `reads` names there — a reference place there followed on by name, and,
 * `transitive`, `reads` applied again at the references those places hold —
 * never a declaration whole but a named shape. `resolved` follows the one
 * reference written at `at`, resolved in the scope holding there, and holds
 * what it resolves to; `named` follows every reference the value at `at`
 * holds, each name read as every declaration of it, present or absent.
 */
export interface RelationTarget {
  readonly at: Keys;
  readonly hop: "resolved" | "named";
  readonly reads: ReferentReads;
  readonly transitive: boolean;
}

/** Reads a rule makes beside what it declared, decided by what its declared
 *  places hold: `place` answers only those, and refuses any other. */
export type DependentRead = (place: (keys: Keys) => unknown) => DependentReads;

/** What a {@link DependentRead} adds, in the forms an instance declares. */
export interface DependentReads {
  readonly places: readonly Keys[];
  readonly targets?: readonly RelationTarget[];
  readonly dependent?: DependentRead;
}

/** What one instance reads beside its anchor. */
export interface RelationReads {
  /** Places of its declaration, by projected keys, the rule asks by place. */
  readonly places: readonly Keys[];
  /** Whether it reads what each expression in its anchor and read places was
   *  typed as. */
  readonly facts?: boolean;
  /** The steps whose results it reads, by name: each a step-result class. */
  readonly steps?: readonly string[];
  /** Whether it resolves names written at its anchor, which read the scopes
   *  declared on the way to it. */
  readonly scopes?: boolean;
  /** Whether it reads what each object on the way to its anchor holds beside
   *  it, shallow: what a union branch on the way is selected by. */
  readonly enclosing?: boolean;
  /** The references it follows, and what it reads in what they reach. */
  readonly targets?: readonly RelationTarget[];
  /** The module functions its expressions call, as written (`Self.fits`):
   *  each read as a module call reads its callee, by name. */
  readonly calls?: readonly string[];
  /** What it reads depending on what its declared places hold. */
  readonly dependent?: DependentRead;
}

/** What an object on the way to an anchor holds beside it, shallow: each
 *  member a scalar, or an empty object or list standing for one. */
export interface EnclosingMembers {
  /** The object's keys, relative to the anchor's manifest. */
  readonly at: Keys;
  readonly members: Record<string, unknown>;
}

/** What one expression was typed as, by the key judging it. */
export interface RelationFacts {
  /** The expression's text, where it was typed. */
  readonly source?: string;
  readonly type?: string;
  readonly literal?: string;
  readonly produced?: Record<string, any>;
  readonly composed?: unknown;
  /** Per referrer typing, when the expression was judged under several. */
  readonly variants?: ReadonlyArray<{
    readonly type?: string;
    readonly literal?: string;
    readonly produced?: Record<string, any>;
    readonly composed?: unknown;
    readonly label?: string;
  }>;
}

/** The door a relation's rule asks: the registries, the named requests, and
 *  the declared read places by place. */
export interface RelationDoor {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly libraries: LibraryDeclarations | undefined;
  readonly validator: ShapeAwareValidator;
  readonly requests: DeclarationRequests;
  /** Which definition the declaration `identity` names is judged against. */
  declared(identity: DeclarationIdentity): DeclaredDefinition;
  /** The names a CEL call's receiver may be in the module `identity` is
   *  declared in. */
  moduleNames(identity: DeclarationIdentity): ReadonlySet<string>;
  /** The declaration a resolved reference written at a place of the anchor
   *  names, read in the scope holding there — refused unless the instance reads
   *  scopes; undefined for an import or a name nothing declares. */
  resolveTarget(reference: Record<string, any>, keys: Keys): Record<string, any> | undefined;
  /** The value at a declared read place; any other place is refused. */
  place(keys: Keys): unknown;
  /** The declaration holding the anchor, as the instance reads it: its
   *  identity and the places it declared, in the scope it is declared in. */
  subject(): ResourceManifest;
  /** The functions an expression written in `caller`'s module may call,
   *  resolved on the first call. */
  functions(caller: ResourceManifest): ModuleCallDispatch;
  /** What the expression at a place of the anchor or a read place was typed
   *  as — refused unless the instance reads facts. */
  facts(keys: Keys): RelationFacts | undefined;
  /** What each object on the way to the anchor holds beside it — refused
   *  unless the instance reads it. */
  enclosing(): readonly EnclosingMembers[];
  /** What the configuration decides of a module instance's inputs. */
  readonly narrowing: InputNarrowing | undefined;
  /** What an import's `variables:` / `secrets:` are typed by: the library's
   *  declared entries. */
  importInputsSchema(importDoc: ResourceManifest): Record<string, any> | undefined;
  /** What the maps feeding a child application are typed by: what the child
   *  the loader followed declares. */
  applicationInputsSchema(resource: ResourceManifest, authorSchema: Record<string, any>): Record<string, any> | undefined;
  /** The `steps` schema the declared step reads are typed against: each named
   *  step's result, every other step open — refused unless the instance reads
   *  steps; undefined where the declaration has no step body. */
  steps(): Record<string, any> | undefined;
}

/** What a relation's rule receives: one instance, never its declaration. */
export interface RelationRuleInput {
  readonly identity: DeclarationIdentity;
  /** The anchor's projected keys, and the value there as normalized. */
  readonly anchor: Keys;
  readonly value: unknown;
  readonly door: RelationDoor;
}

/** One finding of a rule and the place its check judged. */
export interface RelationFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly judgedAt: string;
}

export interface RelationReader {
  instances(region: RelationRegion, scope: RelationReaderScope): readonly RelationInstance[];
  /** Read off the instance's region, its anchor's value as normalized. */
  reads(instance: RelationInstance, region: RelationRegion, scope: RelationReaderScope): RelationReads;
  judge(instance: RelationInstance, input: RelationRuleInput): readonly RelationFinding[];
}

/** One reader per relational group. */
export type RelationReaderTable = {
  readonly [G in RelationalGroup]: RelationReader;
};

/** The fields of `T` that could carry a declaration or a manifest list — a
 *  field typed `unknown` (a value of the instance) aside. */
type DeclarationFields<T> = {
  [K in keyof T]-?: unknown extends T[K]
    ? never
    : T[K] extends ResourceManifest | { readonly manifest: ResourceManifest } | readonly ResourceManifest[]
      ? K
      : ResourceManifest extends T[K]
        ? K
        : never;
}[keyof T];

/** A rule's input and its door hold no declaration and no manifest list:
 *  adding one fails compilation here. */
const holdsNoDeclaration: [DeclarationFields<RelationRuleInput> | DeclarationFields<RelationDoor>] extends [never]
  ? true
  : false = true;
void holdsNoDeclaration;

/** The identity of a relation site: its group and its anchor's written place. */
export function relationSiteId(group: string, kind: unknown, name: unknown, filePath: unknown, path: string): string {
  return JSON.stringify(["relation", group, kind, name, filePath, path]);
}

/** Whether `prefix` is `keys` or above it. */
export function isAtOrAbove(prefix: Keys, keys: Keys): boolean {
  return prefix.length <= keys.length && prefix.every((key, i) => String(key) === String(keys[i]));
}
