import type { ResourceManifest } from "@telorun/sdk";
import type { AnalysisFamily } from "./analysis-families.js";
import { instancesOf, moduleInstanceTree } from "./module-instance-tree.js";
import type { AnalysisRegistry } from "./analysis-registry.js";
import { readApplicationSourceSlot } from "./application-source-slot.js";
import { isKindDocument } from "./kind-declaration.js";
import type { LoadedGraph } from "./loaded-types.js";
import {
  edgesFrom,
  flattenLoadedModule,
  scopedImportMembers,
  scopeHoldersOf,
  stampScopedImportIdentity,
} from "./flatten-for-analyzer.js";
import { isModuleKind } from "./module-kinds.js";
import {
  isNeedTypeDoc,
  isTextFieldSchema,
  NEED_TYPE_KIND,
  needSupplyOf,
  needTypeOf,
  readNeeds,
  needParametersWithDefaults,
  readNeedTypeShape,
  readSuppliedNeeds,
  sensitiveNeedFields,
  type NeedTypeShape,
} from "./need-type.js";
import { derivedNeedEnvName } from "./need-env-name.js";
import {
  isInjectedDeclaration,
  readLibraryLifecycle,
  readResourceInputs,
} from "./resource-input.js";
import { findDynamicLeaf } from "./resource-rule.js";
import { navigateSchemaToExprPath, substituteCelFields, validateAgainstSchema } from "./schema-compat.js";
import {
  describeHostEntry,
  holdsHostPath,
  hostEntryAt,
  hostMediaTypeAt,
  hostMediaTypeFinding,
  hostMediaTypeMismatchAt,
} from "./host-path-slot.js";
import { foundEntryOf, foundHeadOf } from "./module-file-existence.js";
import { membersSlotOf } from "./members-value-slot.js";
import { valueTypeRefusalCode } from "./schema-error-report.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import type { StandIns } from "./stand-in-findings.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModulePathSentinel, isRefSentinel, isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { templateBodyEntries } from "./template-body.js";
import type { ReachSite } from "./reference-reach.js";
import type { NeedConstraint } from "./ref-slot.js";
import { isUnsatisfiable, parseVersionRange, rangeWithin, type VersionRange } from "./version-range.js";
import { callbackPathRefusal, DESKTOP_HOST_TYPE, isPortNeedType } from "./desktop-host.js";
import { PUBLIC_URL_TYPE } from "./public-address.js";
import {
  directoryForwardRefusal,
  DURABLE_DIRECTORY_TYPE,
  durableDirectoryParameters,
} from "./durable-directory.js";
import { generatedParameterRefusals, generatedValueRefusal, isGeneratedSecretType } from "./generated-secret.js";
import { canonicalJson } from "./canonical-json.js";
import { isInlineDeclaration, isResolvedReference } from "./resolved-reference.js";
import { isScopeMember } from "./scope-declarations.js";

/**
 * THE NEED TABLE — every need of a loaded application, where it sits in the
 * import tree, what supplies it, and every refusal decidable from the
 * declarations alone.
 *
 * One reader for every host that asks: `telo check` reports the problems of the
 * entry's own modules, the kernel raises each problem's `ERR_` twin at load
 * before any resource initializes, and a needs report lists the entries. The
 * graph it reads is built by an adapter for each host —
 * {@link needGraphFromLoadedGraph} where the whole graph is in hand (the
 * kernel, the CLI), {@link needGraphFromManifests} over a flattened analysis
 * set, where a dependency is known only through what its importers' stamps say
 * about it, its kinds resolved in its own alias scope.
 *
 * Browser-safe.
 */

/** One `needs:` entry, its kind canonicalized in the declaring module's scope. */
export interface NeedGraphNeed {
  name: string;
  /** As written. */
  kind: string;
  /** Canonical `<module>.<Kind>`, or undefined when the kind resolves to nothing. */
  type?: string;
  parameters?: unknown;
  /** The version range the need states, as written. */
  version?: unknown;
  /** The features the need states, as written. */
  features?: unknown;
  optional: boolean;
  /** Whether the entry writes `env:` (an Application's need only). */
  declaresEnv: boolean;
  /** The environment names it binds, by field. */
  env?: Record<string, string>;
}

/** A resource a module declares, with its kind canonicalized. */
export interface NeedGraphDeclaration {
  name: string;
  kind: string;
  type?: string;
  manifest: ResourceManifest;
  /** Where it is declared, in the graph's logic; everywhere when absent. */
  held?: unknown;
  /** Where each key of its `fields:` is written, in the graph's logic; read
   *  from the manifest when absent. */
  fieldKeys?: ReadonlyMap<string, unknown>;
}

/** One concrete reference site of a declaration — a `!ref` a kind's reference
 *  slot holds — with the need constraints the slot observes. */
export interface NeedGraphReference {
  declaration: NeedGraphDeclaration;
  /** Dotted path of the site in the declaration. */
  path: string;
  target: { name: string; alias?: string };
  observes: NeedConstraint[];
  /** Set when the site supplies a need of a child application the holding
   *  resource runs: that resource's name and the child's need. */
  childNeed?: { holder: string; need: string };
  /** Where the site is written, in the graph's logic; everywhere when absent. */
  held?: unknown;
}

export interface NeedGraphImport {
  alias: string;
  /** The holders of the scope a `Telo.Import` scope member is declared in;
   *  absent for an `imports:` entry. */
  holders?: readonly string[];
  manifest: ResourceManifest;
  /** The key of the target module, when it loaded. */
  target?: string;
  supplied: Record<string, unknown>;
}

export interface NeedGraphModule {
  key: string;
  name: string;
  /** The module document, which a problem about a `needs:` entry anchors on. */
  doc?: ResourceManifest;
  /** Whether the module is a `Telo.Application` — the one kind of module whose
   *  needs bind environment names. */
  application: boolean;
  shared: boolean;
  needs: NeedGraphNeed[];
  resourceInputs: Array<{ name: string; kind: string; type?: string }>;
  /** The places of the declarations whose kind runs a child application
   *  (`x-telo-application-source`), relative to the module instance: the name,
   *  beneath the names of the scope holders for a scope member. */
  applications?: string[][];
  /** Every resource the module declares, or undefined when this graph cannot
   *  see them (a dependency of an analysis given no library documents). */
  declarations?: NeedGraphDeclaration[];
  /** The reference sites of those declarations, or undefined when this graph
   *  cannot see them — which leaves every constraint reaching the module
   *  undecided rather than unverified. */
  references?: NeedGraphReference[];
  /** The module's `Telo.NeedType` documents. */
  needTypes: ResourceManifest[];
  /** Names a need collides with besides declarations: import aliases, kinds,
   *  resource inputs and the module's own name. */
  otherNames: Map<string, string>;
  imports: NeedGraphImport[];
  /** Whether the module's own declarations are checked here. */
  checked: boolean;
}

export interface NeedGraph {
  root: string;
  modules: ReadonlyMap<string, NeedGraphModule>;
  /** The need type a canonical kind registers, or undefined when it is none. */
  needType(kind: string): NeedTypeShape | undefined;
  /** Whether a canonical kind names any registered kind. */
  isKind(kind: string): boolean;
  /** Key of the module whose `Telo.NeedType` document declares a canonical
   *  need type, when this graph holds it. */
  needTypeModule?(type: string): string | undefined;
  /** The optional needs of a module (by name) one configuration proves present —
   *  where a reference to one is legal. */
  presentNeeds?(module: string): ReadonlySet<string> | undefined;
  /** The connectives the declarations' and references' `held` are in; one
   *  configuration's, where every one is `true`, when absent. */
  logic?: NeedLogic<unknown>;
  /** Where a module's optional need is proven present, in {@link logic};
   *  read from {@link presentNeeds} when absent. */
  presentNeed?(module: string, need: string): unknown;
}

/** The connectives a need table's findings are held in. */
export interface NeedLogic<T> {
  readonly TRUE: T;
  readonly FALSE: T;
  and(a: T, b: T): T;
  or(a: T, b: T): T;
  not(a: T): T;
  isFalse(a: T): boolean;
  /** The classes `held` split everywhere into: each non-empty intersection of
   *  every one or its complement. */
  atoms(held: readonly T[]): T[];
}

/** One configuration's logic: everything is `true` or `false`. */
const ONE_CONFIGURATION: NeedLogic<boolean> = {
  TRUE: true,
  FALSE: false,
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  not: (a) => !a,
  isFalse: (a) => !a,
  atoms: () => [true],
};

export interface NeedProblem {
  /** The static code `telo check` reports. */
  code: string;
  /** The code the kernel raises at load. */
  runtimeCode: string;
  /** Name of the module the problem is in — what an analysis scopes on. */
  module: string;
  message: string;
  filePath?: string;
  resource?: { kind: string; name: string };
  path: string;
  /** Where it holds, in the graph's logic. */
  held?: unknown;
  /** The family the finding is judged in where it is not the need table's own. */
  family?: AnalysisFamily;
  /** The declaration — and the reference site of it — it is about, when its
   *  wording and place name them, with how it reads for another rendering of
   *  them (`kind`, `name`, and the site's path). */
  about?: {
    readonly declaration: NeedGraphDeclaration;
    readonly reference?: NeedGraphReference;
    rerender(kind: string, name: string, path: string): { message: string; path: string };
  };
}

/** How a need is fulfilled: supplied whole or field by field at the import that
 *  reaches it; or — reaching the root with nothing supplying it, the root's own
 *  needs included — read from the environment under an Application root, and
 *  left to whoever imports a Library root. */
export type NeedSupplyForm = "whole" | "fields" | "environment" | "importer";

/** One field of a need's type, as its supplier must fill it. */
export interface NeedField {
  required: boolean;
  sensitive: boolean;
}

/** The environment variable one field of a need is read from. */
export interface NeedEnvField extends NeedField {
  env: string;
  /** `bound` — named by the root's `env:`; `derived` — from the need path. */
  envSource: "bound" | "derived";
}

interface NeedTableEntryBase {
  /** Need path: the need's name beneath each importer's alias. */
  path: string[];
  /** For a need supplied whole by an importer's own need: that need's path — the
   *  next link of the whole-forward chain toward its outermost need. */
  forwardedFrom?: string[];
  /** For a need supplied by a fulfilment rather than a need — a declaration
   *  handed over whole, or an import's field-by-field supply — what supplies it,
   *  for a refusal naming where the value came from. */
  suppliedBy?: string;
  /** Key of the module that declares the need. */
  declaredBy: string;
  moduleName: string;
  /** The declaring module's document file, for a message about the need. */
  filePath?: string;
  need: NeedGraphNeed;
  /** Key of the module declaring the need's type, when the graph holds it. */
  typeModule?: string;
  /** The root's import the need is reached through — absent for the root's own. */
  via?: NeedGraphImport;
}

/** A need an import inside the tree supplies, whole or field by field. */
export interface NeedSuppliedEntry extends NeedTableEntryBase {
  supply: "whole" | "fields";
  fields?: undefined;
}

/** A need an Application root reads from the environment: each field of its
 *  type and the one name it is read from. Empty when the type does not resolve. */
export interface NeedEnvironmentEntry extends NeedTableEntryBase {
  supply: "environment";
  fields: Record<string, NeedEnvField>;
}

/** A need reaching a Library root unsupplied, its importer's to supply: each
 *  field of its type, with no environment name. Empty when the type does not
 *  resolve. */
export interface NeedImporterEntry extends NeedTableEntryBase {
  supply: "importer";
  fields: Record<string, NeedField>;
}

export type NeedTableEntry = NeedSuppliedEntry | NeedEnvironmentEntry | NeedImporterEntry;

export interface NeedTable {
  entries: NeedTableEntry[];
  /** Refusals decidable from the declarations. */
  problems: NeedProblem[];
  /** The needs read from the environment at load: under an Application root,
   *  every need reaching it unsupplied, its own included — what an operator
   *  provisions. Empty under a Library root, which reads no environment. */
  environment: NeedEnvironmentEntry[];
  /** The child applications the application's resources run, by path: the
   *  module instance's path and the resource's name (`web`, `Admin.web`) — the
   *  paths a host gives each child a state directory by. */
  applications: string[][];
}

const STATIC_TO_RUNTIME: Record<string, string> = {
  DUPLICATE_RESOURCE_NAME: "ERR_DUPLICATE_RESOURCE",
  SCHEMA_VIOLATION: "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
  UNRESOLVED_REFERENCE: "ERR_REF_UNRESOLVED",
};

function runtimeCodeOf(code: string): string {
  return STATIC_TO_RUNTIME[code] ?? `ERR_${code}`;
}

function sourceOf(m: ResourceManifest | undefined): string | undefined {
  return (m?.metadata as { source?: string } | undefined)?.source;
}

function list(names: Iterable<string>): string {
  const all = [...names];
  return all.length > 0 ? all.join(", ") : "(none)";
}

/** Resolve the need table of `graph`. */
export function resolveNeedTable(graph: NeedGraph): NeedTable {
  const logic = graph.logic ?? ONE_CONFIGURATION;
  const problems: NeedProblem[] = [];
  const problem: Report = (module, code, message, at) => {
    const held = at.held ?? logic.TRUE;
    if (logic.isFalse(held)) return;
    const manifest = at.manifest ?? module.doc;
    problems.push({
      code,
      runtimeCode: runtimeCodeOf(code),
      module: module.name,
      message,
      filePath: sourceOf(manifest),
      resource: at.resource ?? {
        kind: (manifest?.kind as string | undefined) ?? "Telo.Library",
        name: (manifest?.metadata?.name as string | undefined) ?? module.name,
      },
      path: at.path,
      ...(graph.logic ? { held } : {}),
      ...(at.family ? { family: at.family } : {}),
      ...(at.about ? { about: at.about } : {}),
    });
  };

  for (const module of graph.modules.values()) {
    if (module.checked) checkModule(graph, module, problem, logic);
  }
  checkConstraintsVerified(graph, problem, logic);

  const { entries, environment, applications } = walkTree(graph);
  const root = graph.modules.get(graph.root);
  checkLibraryAddressNeeds(graph, problem);
  if (root?.application) {
    checkRootSupplyReached(graph, root, environment, problem);
    checkAddressNeeds(root, problem);
    checkEnvNames(root, environment, problem);
  }
  return { entries, problems, environment, applications };
}

/** A need of a root-only type is fulfilled through a root need forwarded whole,
 *  so a library's need of one reaching the root with nothing forwarding it — to
 *  be read from its derived environment name — is refused at the import that
 *  reaches it. */
function checkRootSupplyReached(
  graph: NeedGraph,
  root: NeedGraphModule,
  environment: readonly NeedEnvironmentEntry[],
  report: Report,
): void {
  for (const entry of environment) {
    if (!entry.via) continue;
    const shape = entry.need.type ? graph.needType(entry.need.type) : undefined;
    if (shape?.supply !== "root") continue;
    report(
      root,
      "NEED_ROOT_SUPPLY_REQUIRED",
      `Need '${entry.path.join(".")}' is of type '${entry.need.type}', which is supplied only ` +
        `through a root need forwarded whole, and nothing forwards it — it would be read from ` +
        `its derived environment name. Declare a need of type '${entry.need.kind}' in this ` +
        `application and supply it at the import: 'needs: { ${entry.need.name}: !ref <that need> }'.`,
      {
        manifest: entry.via.manifest,
        resource: { kind: "Telo.Import", name: entry.via.alias },
        path: "",
      },
    );
  }
}

/** Only a root need names a port — a library has no `ports:` — so a library's
 *  address need states no parameters. */
function checkLibraryAddressNeeds(graph: NeedGraph, report: Report): void {
  for (const module of graph.modules.values()) {
    if (!module.checked || module.application) continue;
    for (const need of module.needs) {
      if (!isPortNeedType(need.type) || need.parameters === undefined) continue;
      report(
        module,
        "NEED_PARAMETERS_INVALID",
        need.type === DESKTOP_HOST_TYPE
          ? `Need '${need.name}' (type '${need.type}') states parameters, and a library's ` +
            `desktop host states none: the identity, the icon and the port are the ` +
            `application's to say. Drop 'parameters:'; the application declares its own ` +
            `'${need.kind}' and forwards it at the import.`
          : `Need '${need.name}' (type '${need.type}') states parameters, and a library's address ` +
            `need states none: the port, the primary and custom domains are the application's to ` +
            `say. Drop 'parameters:'; the application declares its own '${need.kind}' naming a ` +
            `port and forwards it at the import.`,
        { path: `needs.${need.name}.parameters` },
      );
    }
  }
}

/**
 * The parameters of the application's own address needs: each names a `tcp` key
 * of `ports:`, at most one `Telo.PublicUrl` is the primary, and at most one per
 * port takes custom domains.
 */
function checkAddressNeeds(root: NeedGraphModule, report: Report): void {
  const ports = (root.doc as { ports?: unknown } | undefined)?.ports;
  const declaredPorts =
    ports && typeof ports === "object" && !Array.isArray(ports)
      ? (ports as Record<string, { protocol?: unknown } | null>)
      : {};
  let primary: string | undefined;
  const customDomains = new Map<string, string>();
  for (const need of root.needs) {
    if (!isPortNeedType(need.type)) continue;
    const parameters =
      need.parameters && typeof need.parameters === "object" && !Array.isArray(need.parameters)
        ? (need.parameters as Record<string, unknown>)
        : {};
    const path = `needs.${need.name}.parameters`;
    const port = parameters.port;
    if (typeof port !== "string") {
      report(
        root,
        "NEED_PARAMETERS_INVALID",
        `Need '${need.name}' (type '${need.type}') names no port. It is served on a ` +
          `port of this application: write 'parameters: { port: <key of ports:> }'. Ports: ` +
          `${list(Object.keys(declaredPorts))}.`,
        { path },
      );
    } else if (!Object.hasOwn(declaredPorts, port)) {
      report(
        root,
        "NEED_PARAMETERS_INVALID",
        `Need '${need.name}' names port '${port}', which this application's 'ports:' does not ` +
          `declare. Ports: ${list(Object.keys(declaredPorts))}.`,
        { path: `${path}.port` },
      );
    } else if (declaredPorts[port]?.protocol === "udp") {
      report(
        root,
        "NEED_PARAMETERS_INVALID",
        need.type === DESKTOP_HOST_TYPE
          ? `Need '${need.name}' names port '${port}', which is a 'udp' port; a ` +
            `${DESKTOP_HOST_TYPE} names a tcp key of ports:.`
          : `Need '${need.name}' names port '${port}', which is a 'udp' port. An address is ` +
            `served over HTTP, on a 'tcp' port.`,
        { path: `${path}.port` },
      );
    }
    if (need.type === DESKTOP_HOST_TYPE && Array.isArray(parameters.callbackPaths)) {
      parameters.callbackPaths.forEach((callback, i) => {
        const refusal = callbackPathRefusal(callback);
        if (refusal === undefined) return;
        report(
          root,
          "NEED_PARAMETERS_INVALID",
          `Need '${need.name}' callbackPaths[${i}]: ${refusal}. A callback path is a literal ` +
            `app-relative path.`,
          { path: `${path}.callbackPaths[${i}]` },
        );
      });
    }
    if (need.type !== PUBLIC_URL_TYPE) continue;
    if (parameters.primary === true) {
      if (primary !== undefined) {
        report(
          root,
          "NEED_PARAMETERS_INVALID",
          `Need '${need.name}' and need '${primary}' both state 'primary: true'. An application ` +
            `has at most one primary address.`,
          { path: `${path}.primary` },
        );
      } else {
        primary = need.name;
      }
    }
    if (parameters.customDomains === true && typeof port === "string") {
      const other = customDomains.get(port);
      if (other !== undefined) {
        report(
          root,
          "NEED_PARAMETERS_INVALID",
          `Need '${need.name}' and need '${other}' both state 'customDomains: true' on port ` +
            `'${port}'. A domain the host routes to a port must trace to one need, so at most one ` +
            `per port takes custom domains.`,
          { path: `${path}.customDomains` },
        );
      } else {
        customDomains.set(port, need.name);
      }
    }
  }
}

type Report = (
  module: NeedGraphModule,
  code: string,
  message: string,
  at: {
    manifest?: ResourceManifest;
    resource?: { kind: string; name: string };
    path: string;
    held?: unknown;
    family?: AnalysisFamily;
    about?: NeedProblem["about"];
  },
) => void;

/** `NEED_OPTIONAL_REFERENCED`'s wording, for a site at `path` of `kind/name`. */
function optionalNeedReferenceMessage(kind: string, name: string, path: string, need: string): string {
  return (
    `${kind}/${name}: '${path}' references need ` +
    `'${need}', which is optional and may be absent. A reference slot holds ` +
    `a fulfilment for the resource's whole life — reference it only where an '!if' proves it ` +
    `present ('resources.${need} != null'), read its fields through a guarded CEL ` +
    `expression, forward it to a need that is itself optional, or make it required.`
  );
}

function checkModule(graph: NeedGraph, module: NeedGraphModule, report: Report, logic: NeedLogic<unknown>): void {
  // A need type's own declaration: `required:` naming a field it never declares.
  for (const doc of module.needTypes) {
    const shape = readNeedTypeShape(doc);
    const name = doc.metadata?.name as string;
    shape.required.forEach((field, i) => {
      if (field in shape.fields) return;
      report(
        module,
        "NEED_FIELD_UNDECLARED",
        `Telo.NeedType/${name}: 'required' lists '${field}', which is not one of its fields. ` +
          `Fields: ${list(Object.keys(shape.fields))}.`,
        { manifest: doc, resource: { kind: NEED_TYPE_KIND, name }, path: `required[${i}]` },
      );
    });
    // A sensitive value is redacted by replacing its text wherever it is
    // printed, so the mark is `true` and holds only on a field that holds text.
    for (const [field, schema] of Object.entries(shape.fields)) {
      if (!Object.hasOwn(schema, "x-telo-sensitive")) continue;
      const mark = schema["x-telo-sensitive"];
      if (mark !== true) {
        report(
          module,
          "SENSITIVE_ANNOTATION_INVALID",
          `'x-telo-sensitive' must be \`true\`; got ${JSON.stringify(mark)}. It is a marker, not a ` +
            `level — a value other than \`true\` reads as "not sensitive".`,
          { manifest: doc, resource: { kind: NEED_TYPE_KIND, name }, path: `fields.${field}` },
        );
        continue;
      }
      if (isTextFieldSchema(schema)) continue;
      report(
        module,
        "SENSITIVE_ANNOTATION_INVALID",
        `'x-telo-sensitive' on a need-type field requires a string field, or a value type ` +
          `written as text: the value is redacted by replacing its text wherever it is printed, ` +
          `which a ${JSON.stringify(schema.type ?? "untyped")} value has none of. Declare the ` +
          `field 'type: string', or remove the mark.`,
        { manifest: doc, resource: { kind: NEED_TYPE_KIND, name }, path: `fields.${field}` },
      );
    }
  }

  const firstOfUniqueType = new Map<string, NeedGraphNeed>();
  for (const need of module.needs) {
    const at = { path: `needs.${need.name}.kind` };
    const shape = need.type ? graph.needType(need.type) : undefined;
    if (shape?.unique && need.type) {
      const first = firstOfUniqueType.get(need.type);
      if (first) {
        report(
          module,
          "NEED_DUPLICATE",
          `Needs '${first.name}' and '${need.name}' are both ${need.kind}, which a module ` +
            `declares at most once. Keep one need of the type and reference it wherever both ` +
            `were used.`,
          { path: `needs.${need.name}` },
        );
      } else {
        firstOfUniqueType.set(need.type, need);
      }
    }
    if (!shape) {
      report(
        module,
        "NEED_TYPE_UNRESOLVED",
        need.type && graph.isKind(need.type)
          ? `Need '${need.name}' names kind '${need.kind}', which is not a need type. A need ` +
            `names a kind a Telo.NeedType document declares.`
          : `Need '${need.name}' names kind '${need.kind}', which does not resolve to a need ` +
            `type in this module's scope. Write it alias-qualified — '<Alias>.<Kind>' for a ` +
            `need type an import exports, or 'Self.<Kind>' for one this module declares.`,
        at,
      );
    } else {
      checkParameters(module, need, shape, report);
      checkConstraints(module, need, shape, report);
    }
    checkEnvBindings(module, need, shape, report);

    const named = (module.declarations ?? []).filter((d) => d.name === need.name);
    const other = module.otherNames.get(need.name);
    const collision = other ?? (named.length > 0 ? `resource '${need.name}'` : undefined);
    if (collision) {
      report(
        module,
        "DUPLICATE_RESOURCE_NAME",
        `Need '${need.name}' collides with ${collision} declared in module '${module.name}' — ` +
          `a need is a declaration in the module's one namespace. Rename one of them.`,
        {
          path: `needs.${need.name}`,
          ...(other ? {} : { held: named.reduce((held, d) => logic.or(held, d.held ?? logic.TRUE), logic.FALSE) }),
        },
      );
    }
  }

  // An optional need may be absent, so a kind's reference slot — which holds a
  // fulfilment for the resource's whole life — cannot take one.
  const present = graph.presentNeeds?.(module.name);
  const presentHeld = (need: string): unknown =>
    graph.presentNeed ? graph.presentNeed(module.name, need) : present?.has(need) ? logic.TRUE : logic.FALSE;
  // Where each optional need may be absent.
  const optionalNeeds = new Map(
    module.needs.filter((n) => n.optional).map((n) => [n.name, logic.not(presentHeld(n.name))] as const),
  );
  for (const reference of module.references ?? []) {
    const local = reference.target.alias === undefined || reference.target.alias === "Self";
    const absent = local ? optionalNeeds.get(reference.target.name) : undefined;
    if (absent === undefined) continue;
    const declaration = reference.declaration;
    const need = reference.target.name;
    report(
      module,
      "NEED_OPTIONAL_REFERENCED",
      optionalNeedReferenceMessage(declaration.kind, declaration.name, reference.path, need),
      {
        manifest: declaration.manifest,
        resource: { kind: declaration.kind, name: declaration.name },
        path: reference.path,
        family: "presenceReads",
        held: logic.and(reference.held ?? logic.TRUE, absent),
        about: {
          declaration,
          reference,
          rerender: (kind, name, path) => ({ message: optionalNeedReferenceMessage(kind, name, path, need), path }),
        },
      },
    );
  }

  for (const input of module.resourceInputs) {
    if (!input.type || !graph.needType(input.type)) continue;
    report(
      module,
      "RESOURCE_INPUT_NEED_TYPE",
      `Resource input '${input.name}' is constrained to need type '${input.kind}'. A resource ` +
        `input is a live instance the importer must hand over; a value any level up to the ` +
        `environment may supply is a need — declare it under 'needs:'.`,
      { path: `resources.${input.name}.kind` },
    );
  }

  // A fulfilment the module writes itself must be one its type accepts.
  for (const declaration of module.declarations ?? []) {
    const shape = declaration.type ? graph.needType(declaration.type) : undefined;
    if (!shape) continue;
    const held = declaration.held ?? logic.TRUE;
    const resource = { kind: declaration.kind, name: declaration.name };
    if (shape.supply === "root") {
      const message = (kind: string, name: string) =>
        `${kind}/${name}: need type '${declaration.type}' is supplied only ` +
        `through a root need forwarded whole, so a fulfilment of it cannot be written in a ` +
        `manifest. Declare a need of the type under the application's 'needs:' and let whoever ` +
        `runs the application supply it.`;
      report(module, "NEED_ROOT_SUPPLY_REQUIRED", message(declaration.kind, declaration.name), {
        manifest: declaration.manifest,
        resource,
        path: "",
        held,
        about: { declaration, rerender: (kind, name) => ({ message: message(kind, name), path: "" }) },
      });
      continue;
    }
    const fields = (declaration.manifest as Record<string, unknown>).fields;
    const keys =
      declaration.fieldKeys ??
      new Map(
        Object.keys(fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {}).map(
          (key) => [key, logic.TRUE] as const,
        ),
      );
    const findings = (kind: string, name: string) =>
      fieldsFindingsHeld(keys, shape, `${kind}/${name}`, declaration.type!, "fields", logic);
    findings(declaration.kind, declaration.name).forEach((finding, i) => {
      report(module, finding.code, finding.message, {
        manifest: declaration.manifest,
        resource,
        path: finding.path,
        held: logic.and(held, finding.held),
        about: {
          declaration,
          rerender: (kind, name) => {
            const again = findings(kind, name)[i]!;
            return { message: again.message, path: again.path };
          },
        },
      });
    });
  }

  for (const imp of module.imports) {
    const target = imp.target ? graph.modules.get(imp.target) : undefined;
    if (!target) continue;
    checkSupply(graph, module, imp, target, report, logic);
  }
  checkDirectoriesForwardedOnce(graph, module, report, logic);
}

function checkParameters(
  module: NeedGraphModule,
  need: NeedGraphNeed,
  shape: NeedTypeShape,
  report: Report,
): void {
  const path = `needs.${need.name}.parameters`;
  if (!shape.parameters) {
    if (need.parameters === undefined) return;
    report(
      module,
      "NEED_PARAMETERS_INVALID",
      `Need '${need.name}' states parameters, but need type '${need.kind}' declares none.`,
      { path },
    );
    return;
  }
  // A library's port-naming need states none: the application says them.
  if (need.parameters === undefined && !module.application && isPortNeedType(need.type)) return;
  // Parameters are read at load, before anything is evaluated: a literal, or a
  // module file named by location where the parameter is a host path.
  let tagRefused = false;
  for (const { at, sentinel } of taggedParameters(need.parameters, "")) {
    const where = at ? `${path}.${at}` : path;
    if (!isModulePathSentinel(sentinel)) {
      report(
        module,
        "NEED_PARAMETERS_INVALID",
        `${where}: a need parameter takes a literal or !module-path, not !${sentinel.engine} — ` +
          `parameters are read when the application loads, before anything is evaluated.`,
        { path: where },
      );
      tagRefused = true;
      continue;
    }
    const slot = at ? navigateSchemaToExprPath(shape.parameters, at) : shape.parameters;
    if (!holdsHostPath(slot)) {
      report(
        module,
        "NEED_PARAMETERS_INVALID",
        `${where}: a !module-path names a location on the host, and this parameter of need ` +
          `type '${need.kind}' is not a Telo.HostPath.`,
        { path: where },
      );
      tagRefused = true;
      continue;
    }
    const wanted = hostEntryAt(slot);
    const found = foundEntryOf(sentinel);
    if (wanted !== undefined && found !== undefined && wanted !== found) {
      report(
        module,
        "HOST_PATH_ENTRY_MISMATCH",
        `${where}: '${sentinel.source.trim()}' is ${describeHostEntry(found)}; this slot takes ` +
          `${describeHostEntry(wanted)}.`,
        { path: where },
      );
      continue;
    }
    const declared = hostMediaTypeAt(slot);
    const head = foundHeadOf(sentinel);
    const mismatch =
      declared === undefined
        ? undefined
        : found === "directory"
          ? ("directory" as const)
          : head
            ? hostMediaTypeMismatchAt(slot, head)
            : undefined;
    if (declared !== undefined && mismatch) {
      report(
        module,
        "HOST_PATH_CONTENT_MISMATCH",
        hostMediaTypeFinding(
          `${where}: '${sentinel.source.trim()}'`,
          mismatch === "directory" ? mismatch : { mediaType: mismatch.found },
          declared,
        ) + ".",
        { path: where },
      );
    }
  }
  if (tagRefused) return;
  const [issue] = validateAgainstSchema(
    substituteCelFields(need.parameters ?? {}, shape.parameters),
    shape.parameters,
  );
  if (issue) {
    report(
      module,
      "NEED_PARAMETERS_INVALID",
      `Need '${need.name}': parameters do not satisfy need type '${need.kind}' — ` +
        `${issue.path ? `at '${issue.path}': ` : ""}${issue.message}.`,
      { path: issue.path ? `${path}.${issue.path}` : path },
    );
    return;
  }
  if (!need.type || !isGeneratedSecretType(need.type)) return;
  for (const refusal of generatedParameterRefusals(need.type, needParametersWithDefaults(shape, need.parameters))) {
    report(module, "NEED_PARAMETERS_INVALID", `Need '${need.name}': ${refusal.message}.`, {
      path: `${path}.${refusal.path}`,
    });
  }
}

/** Every tagged value in a need's parameters, with its dotted path. */
function taggedParameters(
  value: unknown,
  at: string,
  out: Array<{ at: string; sentinel: TaggedSentinel }> = [],
): Array<{ at: string; sentinel: TaggedSentinel }> {
  if (isTaggedSentinel(value)) {
    out.push({ at, sentinel: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => taggedParameters(item, `${at}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      taggedParameters(item, at ? `${at}.${key}` : key, out);
    }
  }
  return out;
}

/** The range a need states, when it parses — what forwarding and the kernel's
 *  comparison read. */
export function needVersionRange(need: { version?: unknown }): VersionRange | undefined {
  if (typeof need.version !== "string") return undefined;
  const parsed = parseVersionRange(need.version, "need");
  return parsed.ok ? parsed.range : undefined;
}

/** The features a need states, as names. */
export function needFeatures(need: { features?: unknown }): string[] {
  return Array.isArray(need.features)
    ? (need.features as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
}

/** The constraints a need states — `version` only on a versioned type, in the
 *  comparator grammar, satisfiable; `features` only names the type lists. */
function checkConstraints(
  module: NeedGraphModule,
  need: NeedGraphNeed,
  shape: NeedTypeShape,
  report: Report,
): void {
  if (need.version !== undefined) {
    const path = `needs.${need.name}.version`;
    if (shape.version !== "semver") {
      report(
        module,
        "NEED_PARAMETERS_INVALID",
        `Need '${need.name}' states a version, but need type '${need.kind}' is not versioned ` +
          `(it declares no 'version: semver'). Drop 'version:'.`,
        { path },
      );
    } else {
      const parsed = parseVersionRange(need.version, "need");
      if (!parsed.ok) {
        report(
          module,
          "NEED_PARAMETERS_INVALID",
          `Need '${need.name}': 'version' is not a range of explicit comparators — ` +
            `${parsed.error.message}${parsed.error.hint ? `. Write '${parsed.error.hint}'` : ""}.`,
          { path },
        );
      } else if (isUnsatisfiable(parsed.range)) {
        report(
          module,
          "NEED_PARAMETERS_INVALID",
          `Need '${need.name}': version range '${parsed.range.raw}' admits no version.`,
          { path },
        );
      }
    }
  }
  if (need.features !== undefined) {
    const path = `needs.${need.name}.features`;
    const listed = new Set(shape.features ?? []);
    if (!Array.isArray(need.features)) {
      report(module, "NEED_PARAMETERS_INVALID", `Need '${need.name}': 'features' must be a list of feature names.`, { path });
      return;
    }
    (need.features as unknown[]).forEach((feature, i) => {
      if (typeof feature === "string" && listed.has(feature)) return;
      report(
        module,
        "NEED_PARAMETERS_INVALID",
        `Need '${need.name}': feature ${JSON.stringify(feature)} is not one need type ` +
          `'${need.kind}' lists. Features: ${list(listed)}.`,
        { path: `${path}[${i}]` },
      );
    });
  }
}

/** A need's `env:` map: an Application's only, naming fields of its type, and —
 *  once written — binding every required one. */
function checkEnvBindings(
  module: NeedGraphModule,
  need: NeedGraphNeed,
  shape: NeedTypeShape | undefined,
  report: Report,
): void {
  if (!need.declaresEnv) return;
  const path = `needs.${need.name}.env`;
  if (!module.application) {
    report(
      module,
      "LIBRARY_ENV_KEY_REJECTED",
      `Telo.Library needs/${need.name}: 'env:' is only permitted on Telo.Application needs. A ` +
        `library's need is read from its derived name when it reaches the root unsupplied; to ` +
        `choose the name, the application declares a need of its own with 'env:' and supplies ` +
        `it at the import ('needs: { ${need.name}: !ref <its need> }').`,
      { path },
    );
    return;
  }
  if (!shape || !need.env) return;
  for (const field of Object.keys(need.env)) {
    if (field in shape.fields) continue;
    report(
      module,
      "NEED_FIELD_UNDECLARED",
      `Need '${need.name}': 'env:' binds field '${field}', which need type '${need.kind}' does ` +
        `not declare. Fields: ${list(Object.keys(shape.fields))}.`,
      { path: `${path}.${field}` },
    );
  }
  const unbound = shape.required.filter((field) => field in shape.fields && !(field in need.env!));
  if (unbound.length === 0) return;
  report(
    module,
    "NEED_SLOT_MISMATCH",
    `Need '${need.name}': 'env:' does not bind ${unbound.length === 1 ? "the required field" : "the required fields"} ` +
      `${unbound.map((f) => `'${f}'`).join(", ")} of need type '${need.kind}' — an 'env:' map ` +
      `names the variable of every required field.`,
    { path },
  );
}

/**
 * Each environment name is read for exactly one thing. Two need fields reading
 * one name, or a need field reading a name the root's `variables:` / `secrets:`
 * / `ports:` already bind, would hand one value to both — refused, naming both.
 */
function checkEnvNames(
  root: NeedGraphModule,
  environment: readonly NeedEnvironmentEntry[],
  report: Report,
): void {
  const claimed = new Map<string, string>();
  const doc = root.doc as Record<string, unknown> | undefined;
  for (const block of ["variables", "secrets", "ports"] as const) {
    const entries = doc?.[block];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      const env = (entry as { env?: unknown } | null)?.env;
      if (typeof env === "string") claimed.set(env, `${block}.${name}`);
    }
  }
  for (const entry of environment) {
    for (const [field, info] of Object.entries(entry.fields ?? {})) {
      const subject = `need '${entry.path.join(".")}' field '${field}'`;
      const first = claimed.get(info.env);
      if (first === undefined) {
        claimed.set(info.env, subject);
        continue;
      }
      const own = entry.declaredBy === root.key;
      report(
        root,
        "NEED_ENV_NAME_COLLISION",
        `${subject.charAt(0).toUpperCase()}${subject.slice(1)} reads environment variable ` +
          `'${info.env}' (${info.envSource}), which ${first} reads too. Each environment name ` +
          `supplies one value — ` +
          (own
            ? `bind another name with 'env:', or rename the need.`
            : `rename an import alias or a need, or declare a need of this application with ` +
              `'env:' and supply it at the import.`),
        own
          ? {
              path:
                info.envSource === "bound"
                  ? `needs.${entry.need.name}.env.${field}`
                  : `needs.${entry.need.name}`,
            }
          : entry.via
            ? {
                manifest: entry.via.manifest,
                resource: { kind: "Telo.Import", name: entry.via.alias },
                path: "",
              }
            : { path: "imports" },
      );
    }
  }
}

/** One refusal of a supply, before it is anchored: its code, message and path. */
export interface SupplyFinding {
  code: string;
  message: string;
  path: string;
}

/** Every key of `written` a field of the type, every required field present. */
function fieldsFindings(
  written: Record<string, unknown>,
  shape: NeedTypeShape,
  subject: string,
  type: string,
  at: string,
): SupplyFinding[] {
  return fieldsFindingsHeld(
    new Map(Object.keys(written).map((key) => [key, true] as const)),
    shape,
    subject,
    type,
    at,
    ONE_CONFIGURATION,
  ).map(({ code, message, path }) => ({ code, message, path }));
}

/** What is wrong with the keys of a map of fields, each written where `keys`
 *  holds it: every key a field of the type, every required field present — the
 *  missing ones named together, so once per class of where they are written. */
function fieldsFindingsHeld<T>(
  keys: ReadonlyMap<string, T>,
  shape: NeedTypeShape,
  subject: string,
  type: string,
  at: string,
  logic: NeedLogic<T>,
): (SupplyFinding & { held: T })[] {
  const out: (SupplyFinding & { held: T })[] = [];
  for (const [key, held] of keys) {
    if (key in shape.fields) continue;
    out.push({
      code: "NEED_FIELD_UNDECLARED",
      message:
        `${subject}: field '${key}' is not declared by need type '${type}'. Fields: ` +
        `${list(Object.keys(shape.fields))}.`,
      path: `${at}.${key}`,
      held,
    });
  }
  const written = (field: string) => keys.get(field) ?? logic.FALSE;
  for (const atom of logic.atoms(shape.required.map(written))) {
    const missing = shape.required.filter((field) => logic.isFalse(logic.and(atom, written(field))));
    if (missing.length === 0) continue;
    out.push({
      code: "NEED_SLOT_MISMATCH",
      message:
        `${subject} does not yield ${missing.length === 1 ? "the required field" : "the required fields"} ` +
        `${missing.map((f) => `'${f}'`).join(", ")} of need type '${type}' — a fulfilment is every ` +
        `required field of its type.`,
      path: at,
      held: atom,
    });
  }
  return out;
}

/**
 * What is wrong with a need supplied field by field (`subject` names the supply,
 * `<who>: need '<name>'`): every key a field of the type, every required field
 * present, each literal held to its field's schema, and — for a generated type —
 * to the need's `parameters` (`NEED_VALUE_INVALID`); an expression is held to
 * them when the supplier evaluates it.
 */
export function fieldSupplyFindings(
  fields: Record<string, unknown>,
  shape: NeedTypeShape,
  subject: string,
  type: string,
  path: string,
  parameters?: unknown,
): SupplyFinding[] {
  const out = fieldsFindings(fields, shape, subject, type, path);
  out.push(
    ...generatedValueFindings(fields, shape, subject, type, path, parameters, (field) => `field '${field}'`),
  );
  for (const [field, written] of Object.entries(fields)) {
    const schema = shape.fields[field];
    if (!schema) continue;
    // A value type with members reads its text, or an object of its members
    // whose expressions stand in as their members: a literal that does not
    // build, or that an argument refuses, is the type's own refusal.
    const members = membersSlotOf(schema);
    if (members) {
      const standIns: StandIns = new Map();
      const value = substituteDecodedCelFields(written, schema, undefined, { standIns });
      if (standIns.has("")) continue;
      const [issue] = validateAgainstSchema(value, schema);
      if (!issue) continue;
      out.push({
        code: valueTypeRefusalCode(issue) ?? "SCHEMA_VIOLATION",
        message: `${subject}: field '${field}' ${issue.message.replace(/^\/\s*/, "")}.`,
        path: `${path}.${field}`,
      });
      continue;
    }
    if (findDynamicLeaf(written)) continue;
    const [issue] = validateAgainstSchema(written, schema);
    if (!issue) continue;
    out.push({
      code: "SCHEMA_VIOLATION",
      message:
        `${subject}: field '${field}' does not match need type '${type}' — ` +
        `${issue.message.replace(/^\/\s*/, "")}.`,
      path: `${path}.${field}`,
    });
  }
  return out;
}

/**
 * A generated need's literal field values held to the need's parameters
 * (`NEED_VALUE_INVALID`), `describe` naming where a field's value was written;
 * an expression is left to whoever evaluates it. The message never quotes the
 * value.
 */
export function generatedValueFindings(
  fields: Record<string, unknown>,
  shape: NeedTypeShape,
  subject: string,
  type: string,
  path: string,
  parameters: unknown,
  describe: (field: string) => string,
): SupplyFinding[] {
  if (!isGeneratedSecretType(type)) return [];
  const filled = needParametersWithDefaults(shape, parameters);
  const out: SupplyFinding[] = [];
  for (const [field, written] of Object.entries(fields)) {
    if (!(field in shape.fields) || written === undefined || findDynamicLeaf(written)) continue;
    const rule = generatedValueRefusal(type, filled, written);
    if (!rule) continue;
    out.push({
      code: "NEED_VALUE_INVALID",
      message: `${subject} (type '${type}'): ${describe(field)} ${rule}.`,
      path: `${path}.${field}`,
    });
  }
  return out;
}

/**
 * A fulfilment handed whole to a generated need, its literal `fields:` held to
 * that need's parameters — reported at the supply (`path`), since the
 * fulfilment itself states no parameters.
 */
export function fulfilmentValueFindings(
  fulfilment: ResourceManifest,
  shape: NeedTypeShape,
  subject: string,
  type: string,
  path: string,
  parameters: unknown,
  source: string,
): SupplyFinding[] {
  const written = (fulfilment as Record<string, unknown>).fields;
  if (!written || typeof written !== "object" || Array.isArray(written)) return [];
  return generatedValueFindings(
    written as Record<string, unknown>,
    shape,
    subject,
    type,
    path,
    parameters,
    (field) => `'${source}' field '${field}'`,
  ).map((finding) => ({ ...finding, path }));
}

/** A need as a whole forward compares it: what it states and whether it may be absent. */
export interface ForwardedNeed {
  optional: boolean;
  type?: string;
  version?: unknown;
  features?: unknown;
  parameters?: unknown;
}

/**
 * Why `ownNeed`, forwarded whole, cannot supply `need` (`subject` names the
 * supply; `target` the module or application declaring `need`): an optional
 * need supplying a required one, or a need stating less than the one it
 * supplies — no version range or one not within the target's, fewer features, a
 * durable directory's weaker access or smaller size, or, for any other type, a
 * parameter the target states (defaults filled) with another value. Each a
 * `NEED_FORWARD_INCOMPATIBLE` message.
 */
export function wholeForwardRefusals(
  subject: string,
  key: string,
  target: string,
  source: string,
  need: ForwardedNeed,
  ownNeed: ForwardedNeed,
  shape: NeedTypeShape | undefined,
): string[] {
  const out: string[] = [];
  if (ownNeed.optional && !need.optional) {
    out.push(
      `${subject}: need '${key}' is required by ${target}, and '${source}' is an optional need, ` +
        `which may be absent. Make '${source}' required, or supply '${key}' another way.`,
    );
  }
  // A need forwarded whole is compared against at its outermost link, so it
  // must state at least what the need it supplies does.
  const wanted = needVersionRange(need);
  if (wanted) {
    const stated = needVersionRange(ownNeed);
    if (!stated || !rangeWithin(stated, wanted)) {
      out.push(
        `${subject}: need '${key}' of ${target} requires version ` +
          `'${wanted.raw}', and '${source}' ${stated ? `states '${stated.raw}', which is not within it` : "states no version"}. ` +
          `Give '${source}' a 'version:' within '${wanted.raw}'.`,
      );
    }
  }
  const missing = needFeatures(need).filter((f) => !needFeatures(ownNeed).includes(f));
  if (missing.length > 0) {
    out.push(
      `${subject}: need '${key}' of ${target} requires the features ` +
        `${needFeatures(need).map((f) => `'${f}'`).join(", ")}, and '${source}' does not ask for ` +
        `${missing.map((f) => `'${f}'`).join(", ")}. Add ${missing.length === 1 ? "it" : "them"} to its 'features:'.`,
    );
  }
  if (need.type === DURABLE_DIRECTORY_TYPE) {
    const why = directoryForwardRefusal(
      durableDirectoryParameters(shape, ownNeed.parameters),
      durableDirectoryParameters(shape, need.parameters),
    );
    if (why) {
      out.push(
        `${subject}: need '${key}' of ${target} cannot be supplied by ` +
          `'${source}': ${why}. Change the parameters of '${source}', or supply '${key}' another way.`,
      );
    }
  } else if (need.parameters !== undefined) {
    const differ = differingParameters(
      needParametersWithDefaults(shape, need.parameters),
      ownNeed.parameters === undefined ? undefined : needParametersWithDefaults(shape, ownNeed.parameters),
    );
    if (differ) {
      out.push(
        `${subject}: need '${key}' of ${target} states the parameters ${differ.wanted}, and ` +
          `'${source}' states ${differ.stated}, which differ at ${differ.names}. A need forwarded ` +
          `whole states every parameter of the need it supplies with an equal value — give ` +
          `'${source}' the same parameters, or supply '${key}' another way.`,
      );
    }
  }
  return out;
}

/**
 * Where a need stating `supplied` disagrees with the one stating `wanted` it is
 * forwarded whole to (both with their type's defaults filled) — each parameter
 * `wanted` states that `supplied` does not state with an equal value, and both
 * sets as text — or undefined when it agrees. A value is consumed as the
 * outermost need's parameters made it, so "at least" does not apply.
 */
function differingParameters(
  wanted: unknown,
  supplied: unknown,
): { wanted: string; stated: string; names: string } | undefined {
  if (!wanted || typeof wanted !== "object" || Array.isArray(wanted)) return undefined;
  const stated =
    supplied && typeof supplied === "object" && !Array.isArray(supplied)
      ? (supplied as Record<string, unknown>)
      : undefined;
  const differing = Object.entries(wanted as Record<string, unknown>)
    .filter(([name, value]) => !stated || canonicalJson(value) !== canonicalJson(stated[name]))
    .map(([name]) => `'${name}'`);
  if (differing.length === 0) return undefined;
  return {
    wanted: canonicalJson(wanted),
    stated: stated ? canonicalJson(stated) : "none",
    names: differing.join(", "),
  };
}

function checkSupply(
  graph: NeedGraph,
  module: NeedGraphModule,
  imp: NeedGraphImport,
  target: NeedGraphModule,
  report: Report,
  logic: NeedLogic<unknown>,
): void {
  const resource = { kind: "Telo.Import", name: imp.alias };
  const anchor = { manifest: imp.manifest, resource };
  const declared = new Map(target.needs.map((need) => [need.name, need]));
  for (const [key, value] of Object.entries(imp.supplied)) {
    const path = `needs.${key}`;
    const need = declared.get(key);
    if (!need) {
      report(
        module,
        "NEED_UNDECLARED",
        `Import '${imp.alias}' supplies need '${key}', which module '${target.name}' does not ` +
          `declare. Declared needs: ${list(declared.keys())}.`,
        { ...anchor, path },
      );
      continue;
    }
    const shape = need.type ? graph.needType(need.type) : undefined;
    const supply = needSupplyOf(value);
    if (supply.form === "invalid") {
      report(
        module,
        "NEED_SLOT_MISMATCH",
        `Import '${imp.alias}': need '${key}' must be a '!ref' to a need or fulfilment this ` +
          `module declares, or a map of the fields of need type '${need.kind}'.`,
        { ...anchor, path },
      );
      continue;
    }
    if (supply.form === "fields") {
      if (!shape) continue;
      if (shape.supply === "root") {
        report(
          module,
          "NEED_ROOT_SUPPLY_REQUIRED",
          `Import '${imp.alias}': need '${key}' is of type '${need.type}', which is supplied only ` +
            `through a root need forwarded whole, so it cannot be supplied field by field. ` +
            `Declare a need of the type in this module and supply it whole: ` +
            `'needs: { ${key}: !ref <that need> }'.`,
          { ...anchor, path },
        );
        continue;
      }
      for (const finding of fieldSupplyFindings(
        supply.fields,
        shape,
        `Import '${imp.alias}': need '${key}'`,
        need.type!,
        path,
        need.parameters,
      )) {
        report(module, finding.code, finding.message, { ...anchor, path: finding.path });
      }
      continue;
    }
    const source = supply.target.source;
    const local = supply.target.alias === undefined || supply.target.alias === "Self";
    const ownNeed = local ? module.needs.find((n) => n.name === supply.target.name) : undefined;
    const mismatch = (suppliedKind: string, suppliedType: string | undefined, held: unknown) => {
      if (!need.type || !suppliedType || suppliedType === need.type) return;
      report(
        module,
        "REFERENCE_KIND_MISMATCH",
        `Import '${imp.alias}': need '${key}' is need type '${need.type}', and '${source}' is ` +
          `'${suppliedKind}' (resolved: '${suppliedType}'). A need is supplied by a need or ` +
          `fulfilment of its own type.`,
        { ...anchor, path, held },
      );
    };
    if (!ownNeed) {
      // A dependency whose declarations this graph cannot see is not judged.
      if (local && module.declarations === undefined) continue;
      // The first declaration of the name present supplies it.
      let before = logic.FALSE;
      for (const declaration of local ? module.declarations!.filter((d) => d.name === supply.target.name) : []) {
        const first = logic.and(declaration.held ?? logic.TRUE, logic.not(before));
        before = logic.or(before, declaration.held ?? logic.TRUE);
        if (logic.isFalse(first)) continue;
        mismatch(declaration.kind, declaration.type, first);
        if (shape && need.type && declaration.type === need.type) {
          for (const finding of fulfilmentValueFindings(declaration.manifest, shape, `Import '${imp.alias}': need '${key}'`, need.type, path, need.parameters, source)) {
            report(module, finding.code, finding.message, { ...anchor, path: finding.path, held: first });
          }
        }
      }
      report(
        module,
        "UNRESOLVED_REFERENCE",
        `Import '${imp.alias}': need '${key}' → '${source}' names no need or fulfilment module ` +
          `'${module.name}' declares. A need is supplied whole by a '!ref' to one of this ` +
          `module's own needs, or to a fulfilment it declares.`,
        { ...anchor, path, held: logic.not(before) },
      );
      continue;
    }
    if (!need.type || !ownNeed.type) continue;
    if (ownNeed.type !== need.type) {
      mismatch(ownNeed.kind, ownNeed.type, logic.TRUE);
      continue;
    }
    for (const message of wholeForwardRefusals(
      `Import '${imp.alias}'`,
      key,
      `module '${target.name}'`,
      source,
      need,
      ownNeed,
      shape,
    )) {
      report(module, "NEED_FORWARD_INCOMPATIBLE", message, { ...anchor, path });
    }
  }
}

/**
 * One durable directory — a need or a fulfilment of the module — forwarded whole
 * to two or more needs would have two writers over each other's files, so it is
 * refused at every supply after the first, each naming every target: a library's
 * need at an import (a `shared` library's is one need however many imports reach
 * it) and a child application's need, supplied by the resource that runs it.
 */
function checkDirectoriesForwardedOnce(
  graph: NeedGraph,
  module: NeedGraphModule,
  report: Report,
  logic: NeedLogic<unknown>,
): void {
  // Which sites a class of configurations holds decides every finding's
  // wording, so each is judged once per class of where they are written.
  const varying = [
    ...(module.references ?? []).filter((r) => r.childNeed && r.held !== undefined).map((r) => r.held),
    ...(module.declarations ?? []).filter((d) => d.held !== undefined).map((d) => d.held),
  ];
  for (const atom of varying.length === 0 ? [logic.TRUE] : logic.atoms(varying)) {
    const holds = (held: unknown) => held === undefined || !logic.isFalse(logic.and(atom, held));
    directoriesForwardedOnceIn(graph, module, report, atom, holds);
  }
}

function directoriesForwardedOnceIn(
  graph: NeedGraph,
  module: NeedGraphModule,
  report: Report,
  held: unknown,
  holds: (held: unknown) => boolean,
): void {
  type Site = {
    target: string;
    anchor: { manifest: ResourceManifest; resource: { kind: string; name: string }; path: string; held: unknown };
  };
  const forwards = new Map<string, Site[]>();
  const isDirectory = (name: string) =>
    (module.needs.find((n) => n.name === name)?.type ??
      module.declarations?.find((d) => d.name === name && holds(d.held))?.type) === DURABLE_DIRECTORY_TYPE;
  const add = (name: string, site: Site) => {
    if (!isDirectory(name)) return;
    const sites = forwards.get(name) ?? [];
    if (!sites.some((s) => s.target === site.target)) sites.push(site);
    forwards.set(name, sites);
  };
  for (const imp of module.imports) {
    const target = imp.target ? graph.modules.get(imp.target) : undefined;
    if (!target) continue;
    for (const [key, value] of Object.entries(imp.supplied)) {
      const supply = needSupplyOf(value);
      if (supply.form !== "whole") continue;
      if (supply.target.alias !== undefined && supply.target.alias !== "Self") continue;
      add(supply.target.name, {
        target: target.shared ? `${target.name}.${key}` : `${imp.alias}.${key}`,
        anchor: { manifest: imp.manifest, resource: { kind: "Telo.Import", name: imp.alias }, path: `needs.${key}`, held },
      });
    }
  }
  for (const reference of module.references ?? []) {
    if (!reference.childNeed || !holds(reference.held)) continue;
    if (reference.target.alias !== undefined && reference.target.alias !== "Self") continue;
    const { declaration } = reference;
    add(reference.target.name, {
      target: `${reference.childNeed.holder}.${reference.childNeed.need}`,
      anchor: {
        manifest: declaration.manifest,
        resource: { kind: declaration.kind, name: declaration.name },
        path: reference.path,
        held,
      },
    });
  }
  for (const [name, sites] of forwards) {
    if (sites.length < 2) continue;
    const targets = sites.map((site) => `'${site.target}'`).join(", ");
    for (const site of sites.slice(1)) {
      report(
        module,
        "NEED_DIRECTORY_FORWARDED_TWICE",
        `Durable directory '${name}' is forwarded whole to ${sites.length} needs — ${targets} — and ` +
          `each would write over the others' files. Give each its own directory; a library that ` +
          `must share one with another declares that in one library, not by forwarding.`,
        site.anchor,
      );
    }
  }
}

/** What a module's needs are verified for: per need, the constraints some
 *  observing slot reaches — or `undefined` when the walk cannot see a module on
 *  the way, which leaves the need undecided. */
type Observed = ReadonlyMap<string, ReadonlySet<NeedConstraint> | undefined>;

/**
 * THE CONSTRAINT-REACHABILITY WALK — a stated `version` / `features` is
 * verified iff it reaches a reference slot whose `observes` lists it: through
 * the declaring module's own reference sites, or through a whole `!ref` forward
 * at an import into the target's need, recursively. Downward only, so a
 * library's verdict for its own needs is the same under every importer;
 * memoized per declaring module.
 */
export function constraintObservations(graph: NeedGraph): (moduleKey: string) => Observed {
  const held = heldObservations(graph, ONE_CONFIGURATION);
  return (moduleKey) => {
    const out = new Map<string, Set<NeedConstraint> | undefined>();
    for (const [need, reached] of held(moduleKey)) {
      out.set(need, reached && new Set([...reached].filter(([, at]) => at).map(([constraint]) => constraint)));
    }
    return out;
  };
}

/** {@link constraintObservations} in `logic`: per need, where each constraint
 *  some observing slot reaches is reached. */
function heldObservations<T>(
  graph: NeedGraph,
  logic: NeedLogic<T>,
): (moduleKey: string) => ReadonlyMap<string, ReadonlyMap<NeedConstraint, T> | undefined> {
  type HeldObserved = ReadonlyMap<string, ReadonlyMap<NeedConstraint, T> | undefined>;
  const memo = new Map<string, HeldObserved>();
  const inProgress = new Set<string>();
  const observedOf = (moduleKey: string): HeldObserved => {
    const known = memo.get(moduleKey);
    if (known) return known;
    const module = graph.modules.get(moduleKey);
    const out = new Map<string, Map<NeedConstraint, T> | undefined>();
    if (!module || inProgress.has(moduleKey)) return out;
    inProgress.add(moduleKey);
    for (const need of module.needs) {
      if (!module.references) {
        out.set(need.name, undefined);
        continue;
      }
      out.set(need.name, new Map());
    }
    const merge = (name: string, from: ReadonlyMap<NeedConstraint, T> | undefined) => {
      if (!out.has(name)) return;
      const into = out.get(name);
      if (!into) return;
      if (!from) {
        out.set(name, undefined);
        return;
      }
      for (const [c, at] of from) into.set(c, logic.or(into.get(c) ?? logic.FALSE, at));
    };
    for (const reference of module.references ?? []) {
      const local = reference.target.alias === undefined || reference.target.alias === "Self";
      const at = (reference.held ?? logic.TRUE) as T;
      if (local) merge(reference.target.name, new Map(reference.observes.map((c) => [c, at] as const)));
    }
    for (const imp of module.imports) {
      const target = imp.target ? graph.modules.get(imp.target) : undefined;
      for (const [key, value] of Object.entries(imp.supplied)) {
        const supply = needSupplyOf(value);
        if (supply.form !== "whole") continue;
        const local = supply.target.alias === undefined || supply.target.alias === "Self";
        if (!local || !out.has(supply.target.name)) continue;
        merge(supply.target.name, target ? observedOf(target.key).get(key) : undefined);
      }
    }
    inProgress.delete(moduleKey);
    memo.set(moduleKey, out);
    return out;
  };
  return observedOf;
}

function checkConstraintsVerified(graph: NeedGraph, report: Report, logic: NeedLogic<unknown>): void {
  const observedOf = heldObservations(graph, logic);
  for (const module of graph.modules.values()) {
    if (!module.checked) continue;
    const observed = observedOf(module.key);
    for (const need of module.needs) {
      // A constraint the need cannot state is refused by `NEED_PARAMETERS_INVALID`
      // and not judged again here.
      const shape = need.type ? graph.needType(need.type) : undefined;
      if (!shape) continue;
      const stated: NeedConstraint[] = [];
      if (shape.version === "semver" && needVersionRange(need)) stated.push("version");
      if (needFeatures(need).some((f) => shape.features?.includes(f))) stated.push("features");
      if (stated.length === 0 || !observed.has(need.name)) continue;
      const reached = observed.get(need.name);
      if (!reached) continue;
      for (const constraint of stated) {
        const unreached = logic.not(reached.get(constraint) ?? logic.FALSE);
        if (logic.isFalse(unreached)) continue;
        report(
          module,
          "NEED_CONSTRAINT_UNVERIFIED",
          `Need '${need.name}' states '${constraint}', and nothing verifies it: no reference slot ` +
            `observing '${constraint}' holds this need, in module '${module.name}' or in any need it ` +
            `is forwarded to whole. Reference the need whole at a slot that observes it, or drop ` +
            `'${constraint}:' — a pure provisioning request belongs in the type's 'parameters'.`,
          { path: `needs.${need.name}.${constraint}`, held: unreached },
        );
      }
    }
  }
}

/** The entry at `path`. */
export function needEntryAt(table: NeedTable, path: readonly string[]): NeedTableEntry | undefined {
  const key = path.join(".");
  return table.entries.find((entry) => entry.path.join(".") === key);
}

/** The outermost need of the whole-forward chain `path` belongs to: the entry
 *  itself when nothing forwarded it, otherwise the importer need it was
 *  forwarded from, recursively — the need whose constraints are enforced. */
export function outermostNeedEntry(
  table: NeedTable,
  path: readonly string[],
): NeedTableEntry | undefined {
  let entry = needEntryAt(table, path);
  const seen = new Set<string>();
  while (entry?.forwardedFrom && !seen.has(entry.path.join("."))) {
    seen.add(entry.path.join("."));
    const next = needEntryAt(table, entry.forwardedFrom);
    if (!next) break;
    entry = next;
  }
  return entry;
}

/** Walk the import tree from the root: one entry per need of every module
 *  instance, under its need path. A `shared` library is one instance, its needs
 *  beneath its own name directly under the root. */
function walkTree(graph: NeedGraph): {
  entries: NeedTableEntry[];
  environment: NeedEnvironmentEntry[];
  applications: string[][];
} {
  const entries: NeedTableEntry[] = [];
  const root = graph.modules.get(graph.root);
  // What fills a need nothing in the tree supplies: an Application's
  // environment, a Library's importer.
  const unsupplied: "environment" | "importer" = root?.application ? "environment" : "importer";
  const add = (
    module: NeedGraphModule,
    need: NeedGraphNeed,
    path: string[],
    supply: NeedSupplyForm,
    via: NeedGraphImport | undefined,
    link?: { forwardedFrom?: string[]; suppliedBy?: string },
  ): void => {
    const typeModule = need.type ? graph.needTypeModule?.(need.type) : undefined;
    const base: NeedTableEntryBase = {
      path,
      ...(link?.forwardedFrom ? { forwardedFrom: link.forwardedFrom } : {}),
      ...(link?.suppliedBy ? { suppliedBy: link.suppliedBy } : {}),
      declaredBy: module.key,
      moduleName: module.name,
      ...(sourceOf(module.doc) !== undefined ? { filePath: sourceOf(module.doc) } : {}),
      need,
      ...(typeModule !== undefined ? { typeModule } : {}),
    };
    const reached = via ? { via } : {};
    if (supply === "environment") {
      entries.push({ ...base, supply, fields: envFields(graph, need, path), ...reached });
    } else if (supply === "importer") {
      entries.push({ ...base, supply, fields: importerFields(graph, need), ...reached });
    } else {
      entries.push({ ...base, supply, ...reached });
    }
  };

  // The root's own needs have no importer inside the tree.
  if (root) {
    for (const need of root.needs) add(root, need, [need.name], unsupplied, undefined);
  }

  const tree = moduleInstanceTree<NeedGraphImport>(graph.root, {
    importsOf: (key) => graph.modules.get(key)?.imports ?? [],
    targetOf: (imp) => (imp.target !== undefined && graph.modules.has(imp.target) ? imp.target : undefined),
    aliasOf: (imp) => imp.alias,
    holdersOf: (imp) => imp.holders ?? [],
    isShared: (key) => graph.modules.get(key)?.shared === true,
    nameOf: (key) => graph.modules.get(key)!.name,
  });
  for (const instance of instancesOf(tree)) {
    const { importer, via: imp } = instance;
    if (!importer || !imp) continue;
    const module = graph.modules.get(importer.module)!;
    const target = graph.modules.get(instance.module)!;
    const prefix = importer.path;
    for (const need of target.needs) {
      const value = imp.supplied[need.name];
      const read = value === undefined ? undefined : needSupplyOf(value);
      const supply: NeedSupplyForm =
        read === undefined ? unsupplied : read.form === "whole" ? "whole" : "fields";
      let link: { forwardedFrom?: string[]; suppliedBy?: string } | undefined;
      if (read?.form === "whole") {
        const name = read.target.name;
        link = module.needs.some((n) => n.name === name)
          ? { forwardedFrom: [...prefix, name] }
          : { suppliedBy: `declaration '${name}' of module '${module.name}'` };
      } else if (read) {
        link = { suppliedBy: `the field-by-field supply at import '${imp.alias}' of module '${module.name}'` };
      }
      add(target, need, [...instance.path, need.name], supply, instance.reachedVia, link);
    }
  }
  const applications = instancesOf(tree).flatMap((instance) =>
    (graph.modules.get(instance.module)?.applications ?? []).map((place) => [...instance.path, ...place]),
  );
  return {
    entries,
    environment: entries.filter((entry): entry is NeedEnvironmentEntry => entry.supply === "environment"),
    applications,
  };
}

/** Each field of a need's type as its supplier must fill it. */
function importerFields(graph: NeedGraph, need: NeedGraphNeed): Record<string, NeedField> {
  const shape = need.type ? graph.needType(need.type) : undefined;
  if (!shape) return {};
  const sensitive = new Set(sensitiveNeedFields(shape));
  const out: Record<string, NeedField> = {};
  for (const field of Object.keys(shape.fields)) {
    out[field] = { required: shape.required.includes(field), sensitive: sensitive.has(field) };
  }
  return out;
}

/** Each field of a need's type and the one environment name it is read from:
 *  the name the root's `env:` binds, otherwise the name derived from the path. */
function envFields(
  graph: NeedGraph,
  need: NeedGraphNeed,
  path: readonly string[],
): Record<string, NeedEnvField> {
  const out: Record<string, NeedEnvField> = {};
  for (const [field, info] of Object.entries(importerFields(graph, need))) {
    const bound = need.env?.[field];
    out[field] = {
      env: bound ?? derivedNeedEnvName(path, field),
      envSource: bound !== undefined ? "bound" : "derived",
      ...info,
    };
  }
  return out;
}


export interface NeedGraphScope {
  /** Canonicalize `kind` in the scope of module `moduleName`. */
  resolveKind(moduleName: string, kind: string): string | undefined;
  needType(kind: string): NeedTypeShape | undefined;
  isKind(kind: string): boolean;
  /** The concrete reference sites of a declaration whose kind is canonical —
   *  the registry's one reach. Absent: the graph sees no reference sites. */
  referenceSites?(manifest: ResourceManifest): readonly ReachSite[];
  /** For a canonical kind running a child application, the keys of the field
   *  feeding the child's `needs:` (`x-telo-application-source`). */
  applicationNeedsFeed?(kind: string): readonly string[] | undefined;
  /** Whether a canonical kind runs a child application, whatever it feeds it. */
  runsApplication?(kind: string): boolean;
}

/**
 * The scope a loaded graph's need table resolves kinds in: the registry an
 * analysis of the whole graph filled, each module's kinds through that
 * module's own alias table — the entry's being the registry itself.
 */
export function needGraphScopeOf(
  registry: AnalysisRegistry,
  entryModule: string | undefined,
): NeedGraphScope {
  return {
    resolveKind: (module, kind) =>
      (module === entryModule ? registry : registry.forModule(module)).resolveKind(kind),
    needType: (kind) => needTypeOf(registry.resolveDefinition(kind)),
    isKind: (kind) => registry.resolveDefinition(kind) !== undefined,
    referenceSites: (manifest) => registry.referenceSitesOf(manifest),
    applicationNeedsFeed: (kind) => {
      const { definitions } = registry._context();
      const definition = registry.resolveDefinition(kind);
      return definition ? readApplicationSourceSlot(definitions?.effectiveSchemaOf(definition))?.feeds.needs : undefined;
    },
    runsApplication: (kind) => {
      const { definitions } = registry._context();
      const definition = registry.resolveDefinition(kind);
      return definition ? readApplicationSourceSlot(definitions?.effectiveSchemaOf(definition)) !== undefined : false;
    },
  };
}

/** Build one module's unit from its full document set. */
function moduleUnit(
  key: string,
  manifests: readonly ResourceManifest[],
  scope: NeedGraphScope,
  targetOf: (imp: ResourceManifest, alias: string) => string | undefined,
): NeedGraphModule | undefined {
  const doc = manifests.find((m) => isModuleKind(m.kind));
  const name = doc?.metadata?.name;
  if (!doc || typeof name !== "string") return undefined;
  const resolve = (kind: string) => scope.resolveKind(name, kind);
  const otherNames = new Map<string, string>();
  otherNames.set(name, `this module's own name`);
  const declarations: NeedGraphDeclaration[] = [];
  const bodies: TemplateBodyDeclaration[] = [];
  const imports: NeedGraphImport[] = [];
  const needTypes: ResourceManifest[] = [];
  for (const m of manifests) {
    if (isModuleKind(m.kind) || isInjectedDeclaration(m)) continue;
    const declared = m.metadata?.name;
    if (typeof declared !== "string") continue;
    if (m.kind === "Telo.Import") {
      otherNames.set(declared, `import alias '${declared}'`);
      imports.push({
        alias: declared,
        manifest: m,
        target: targetOf(m, declared),
        supplied: readSuppliedNeeds(m),
      });
      continue;
    }
    if (isNeedTypeDoc(m)) needTypes.push(m);
    if (isKindDocument(m)) {
      otherNames.set(declared, `${m.kind} '${declared}'`);
      const entries = templateBodyEntries(m);
      const holder = { name: declared, kind: m.kind as string, manifest: m };
      const siblings = new Set(
        entries.map((e) => e.manifest.metadata?.name).filter((n): n is string => typeof n === "string"),
      );
      for (const entry of entries) {
        bodies.push({ holder, manifest: entry.manifest, type: resolve(entry.kind), prefix: entry.prefix, siblings });
      }
      continue;
    }
    declarations.push({ name: declared, kind: m.kind as string, type: resolve(m.kind as string), manifest: m });
  }
  // A scope member's import is a module instance of its own, beneath its holders.
  for (const { member } of scopedImportMembers(manifests)) {
    const alias = member.metadata?.name as string;
    imports.push({
      alias,
      holders: scopeHoldersOf(member) ?? [],
      manifest: member,
      target: (member.metadata as { resolvedSource?: string }).resolvedSource,
      supplied: readSuppliedNeeds(member),
    });
  }
  const resourceInputs = readResourceInputs(doc).map((input) => {
    otherNames.set(input.name, `resource input '${input.name}'`);
    return { name: input.name, kind: input.kind, type: resolve(input.kind) };
  });
  return {
    key,
    name,
    doc,
    application: doc.kind === "Telo.Application",
    shared: readLibraryLifecycle(doc) === "shared",
    needs: readNeeds(doc).map((need) => ({ ...need, type: resolve(need.kind) })),
    resourceInputs,
    declarations,
    applications: applicationsOf(declarations, resolve, scope),
    ...(scope.referenceSites
      ? {
          references: referencesOf(declarations, bodies, resolve, scope.referenceSites, (kind) =>
            scope.applicationNeedsFeed?.(kind),
          ),
        }
      : {}),
    needTypes,
    otherNames,
    imports,
    checked: true,
  };
}

/** The places of a module's child applications: each top-level declaration
 *  whose kind runs one, and each scope member that does, beneath its holders'
 *  names as a scoped import's instance is. */
function applicationsOf(
  declarations: readonly NeedGraphDeclaration[],
  resolve: (kind: string) => string | undefined,
  scope: NeedGraphScope,
): string[][] {
  const out: string[][] = [];
  const visit = (manifest: ResourceManifest, type: string | undefined, holders: readonly string[]): void => {
    const name = manifest.metadata?.name as string;
    const place = [...holders, name];
    if (type !== undefined && scope.runsApplication?.(type) === true) out.push(place);
    if (type === undefined || !scope.referenceSites) return;
    const view = manifest.kind === type ? manifest : ({ ...manifest, kind: type } as ResourceManifest);
    for (const site of scope.referenceSites(view)) {
      if (site.scopes.length === 0 || !Array.isArray(site.data)) continue;
      for (const entry of site.data) {
        if (!isScopeMember(entry)) continue;
        visit(entry, resolve(entry.kind as string), place);
      }
    }
  };
  for (const declaration of declarations) visit(declaration.manifest, declaration.type, []);
  return out;
}

/** What a reference slot's value names: a `!ref` sentinel, or the `{kind, name}`
 *  reference it is rewritten into. */
function referenceTarget(value: unknown): { name: string; alias?: string } | undefined {
  if (isRefSentinel(value)) {
    const target = refSentinelTarget(value);
    return target ? { name: target.name, ...(target.alias ? { alias: target.alias } : {}) } : undefined;
  }
  if (!isResolvedReference(value)) return undefined;
  return { name: value.name, ...(value.alias !== undefined ? { alias: value.alias } : {}) };
}

/** A `resources:` entry of a template body the module declares: a declaration
 *  of its own kind whose references resolve against its sibling entries first,
 *  then the module's own declarations — reported against the definition. */
interface TemplateBodyDeclaration {
  holder: NeedGraphDeclaration;
  manifest: ResourceManifest;
  type: string | undefined;
  prefix: string;
  siblings: ReadonlySet<string>;
}

/** Every reference site of a module's declarations — and of the declarations
 *  written inline inside them, at a reference slot or in a `with:` scope, each
 *  reported against the declaration that holds it — and of its template bodies'
 *  entries, where a reference naming a sibling entry is no reference to the
 *  module. */
function referencesOf(
  declarations: readonly NeedGraphDeclaration[],
  bodies: readonly TemplateBodyDeclaration[],
  resolve: (kind: string) => string | undefined,
  sitesOf: (manifest: ResourceManifest) => readonly ReachSite[],
  needsFeedOf: (kind: string) => readonly string[] | undefined,
): NeedGraphReference[] {
  const out: NeedGraphReference[] = [];
  const visit = (
    declaration: NeedGraphDeclaration,
    manifest: ResourceManifest,
    type: string | undefined,
    prefix: string,
    siblings?: ReadonlySet<string>,
  ): void => {
    if (!type) return;
    const view = manifest.kind === type ? manifest : ({ ...manifest, kind: type } as ResourceManifest);
    const feed = needsFeedOf(type);
    const holder = manifest.metadata?.name;
    for (const site of sitesOf(view)) {
      const at = prefix ? `${prefix}.${site.path}` : site.path;
      const nested = (value: unknown, path: string) => {
        if (!isInlineDeclaration(value)) return;
        const inline = value as unknown as ResourceManifest;
        visit(declaration, inline, resolve(inline.kind), path, siblings);
      };
      if (site.scopes.length > 0 && Array.isArray(site.data)) {
        site.data.forEach((entry, i) => nested(entry, `${at}[${i}]`));
        continue;
      }
      if (site.refs.length === 0) continue;
      const target = referenceTarget(site.data);
      if (!target) {
        nested(site.data, at);
        continue;
      }
      const local = target.alias === undefined || target.alias === "Self";
      if (local && siblings?.has(target.name)) continue;
      const observes = new Set<NeedConstraint>();
      for (const ref of site.refs) for (const c of ref.slot.observes ?? []) observes.add(c);
      const childNeed =
        feed && typeof holder === "string" && site.keys.length === feed.length + 1 &&
        feed.every((key, i) => site.keys[i] === key)
          ? { holder, need: String(site.keys[feed.length]) }
          : undefined;
      out.push({ declaration, path: at, target, observes: [...observes], ...(childNeed ? { childNeed } : {}) });
    }
  };
  for (const declaration of declarations) {
    visit(declaration, declaration.manifest, declaration.type, "");
  }
  for (const body of bodies) {
    visit(body.holder, body.manifest, body.type, body.prefix, body.siblings);
  }
  return out;
}

/** The reference sites of one declaration of module `module`, as its unit
 *  lists them. */
export function declarationReferences(
  module: string,
  declaration: NeedGraphDeclaration,
  scope: NeedGraphScope,
): NeedGraphReference[] {
  if (!scope.referenceSites) return [];
  return referencesOf([declaration], [], (kind) => scope.resolveKind(module, kind), scope.referenceSites, (kind) =>
    scope.applicationNeedsFeed?.(kind),
  );
}

/** The reference sites of a template definition's body entries — the body as
 *  `definition` holds it — reported against `holder`, as module `module`'s
 *  unit lists them. */
export function templateBodyReferences(
  module: string,
  definition: ResourceManifest,
  holder: NeedGraphDeclaration,
  scope: NeedGraphScope,
): NeedGraphReference[] {
  if (!scope.referenceSites) return [];
  const resolve = (kind: string) => scope.resolveKind(module, kind);
  const entries = templateBodyEntries(definition);
  const siblings = new Set(entries.map((e) => e.manifest.metadata?.name).filter((n): n is string => typeof n === "string"));
  const bodies = entries.map((entry) => ({ holder, manifest: entry.manifest, type: resolve(entry.kind), prefix: entry.prefix, siblings }));
  return referencesOf([], bodies, resolve, scope.referenceSites, (kind) => scope.applicationNeedsFeed?.(kind));
}

/** The need graph of a whole loaded application — every module it runs: the
 *  modules the import edges reach from the root. A version reconciliation lost
 *  stays loaded, as does every module only it imports, but no edge reaches
 *  them and the application never runs them, so they have no unit. */
export function needGraphFromLoadedGraph(graph: LoadedGraph, scope: NeedGraphScope): NeedGraph {
  stampScopedImportIdentity(graph);
  const modules = new Map<string, NeedGraphModule>();
  const reached = new Set<string>([graph.rootSource]);
  const queue = [graph.rootSource];
  while (queue.length > 0) {
    const mod = graph.modules.get(queue.shift()!);
    if (!mod) continue;
    for (const edge of edgesFrom(graph, mod.owner.source)) {
      if (reached.has(edge.targetSource)) continue;
      reached.add(edge.targetSource);
      queue.push(edge.targetSource);
    }
  }
  for (const [source, mod] of graph.modules) {
    if (!reached.has(source)) continue;
    const unit = moduleUnit(source, flattenLoadedModule(mod), scope, (imp, alias) => {
      const owner = sourceOf(imp);
      return owner ? graph.importEdges.get(owner)?.get(alias)?.targetSource : undefined;
    });
    if (unit) modules.set(source, unit);
  }
  const typeModules = new Map<string, string>();
  for (const unit of modules.values()) {
    for (const doc of unit.needTypes) {
      const type = `${unit.name}.${doc.metadata?.name as string}`;
      if (!typeModules.has(type)) typeModules.set(type, unit.key);
    }
  }
  return {
    root: graph.rootSource,
    modules,
    needType: scope.needType,
    isKind: scope.isKind,
    needTypeModule: (type) => typeModules.get(type),
  };
}

/**
 * The need graph of a flattened analysis set. The entry's own modules are
 * whole, and so is every imported library whose full documents the analysis
 * holds (`libraries`) — built exactly as a loaded graph's units are, so the
 * analysis and the kernel walk the same shape. A library the analysis holds no
 * documents for is known only through the `metadata.requiredNeeds` stamp on the
 * imports reaching it: its needs, never its declarations, so nothing about
 * what it verifies is decided from it.
 */
export function needGraphFromManifests(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  scope: NeedGraphScope,
  libraries: readonly ModuleDocuments[] = [],
): NeedGraph | undefined {
  const modules = new Map<string, NeedGraphModule>();
  /** Every flattened `Telo.Import`, by declaring module and alias — where a
   *  library document's own import learns what it resolved to. */
  const flatImports = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    flatImports.set(`${module ?? ""}\0${m.metadata?.name as string}`, m);
  }
  const targetOfImport = (imp: ResourceManifest): string | undefined => {
    const meta = imp.metadata as { resolvedSource?: string; resolvedModuleName?: string };
    return meta.resolvedSource ?? meta.resolvedModuleName;
  };
  let root: string | undefined;
  for (const doc of manifests) {
    if (!isModuleKind(doc.kind)) continue;
    const name = doc.metadata?.name;
    if (typeof name !== "string" || (rootModules.size > 0 && !rootModules.has(name))) continue;
    const own = manifests.filter(
      (m) =>
        m === doc ||
        ((m.metadata as { module?: string } | undefined)?.module === name &&
          !(m.metadata as { forwardedExport?: boolean }).forwardedExport &&
          !(m.metadata as { forwardedInternal?: boolean }).forwardedInternal &&
          !(m.metadata as { forwardedShape?: boolean }).forwardedShape),
    );
    const unit = moduleUnit(name, own, scope, targetOfImport);
    if (!unit) continue;
    modules.set(name, unit);
    root ??= name;
  }
  if (root === undefined) return undefined;

  const documentsOf = (target: string, moduleName: string | undefined) =>
    libraries.find((l) => l.sourceId === target) ??
    (moduleName !== undefined ? libraries.find((l) => l.module === moduleName) : undefined);
  const pending = [...modules.values()];
  while (pending.length > 0) {
    const unit = pending.shift()!;
    for (const imp of unit.imports) {
      if (!imp.target || modules.has(imp.target)) continue;
      const meta = imp.manifest.metadata as {
        resolvedModuleName?: string;
        sharedLibrary?: boolean;
        requiredNeeds?: Record<
          string,
          { kind: string; optional: boolean; parameters?: unknown; version?: unknown; features?: unknown }
        >;
      };
      const targetName = meta.resolvedModuleName ?? imp.target;
      const documents = documentsOf(imp.target, meta.resolvedModuleName);
      const whole = documents
        ? moduleUnit(imp.target, documents.manifests, scope, (libImport, alias) => {
            const flat = flatImports.get(`${documents.module}\0${alias}`);
            return flat ? targetOfImport(flat) : targetOfImport(libImport);
          })
        : undefined;
      if (whole) {
        modules.set(imp.target, whole);
        pending.push(whole);
        continue;
      }
      modules.set(imp.target, {
        key: imp.target,
        name: targetName,
        application: false,
        shared: meta.sharedLibrary === true,
        needs: Object.entries(meta.requiredNeeds ?? {}).map(([name, need]) => ({
          name,
          kind: need.kind,
          type: scope.resolveKind(targetName, need.kind),
          optional: need.optional === true,
          declaresEnv: false,
          ...(need.parameters !== undefined ? { parameters: need.parameters } : {}),
          ...(need.version !== undefined ? { version: need.version } : {}),
          ...(need.features !== undefined ? { features: need.features } : {}),
        })),
        resourceInputs: [],
        needTypes: [],
        otherNames: new Map(),
        imports: [],
        checked: false,
      });
    }
  }
  return { root, modules, needType: scope.needType, isKind: scope.isKind };
}
