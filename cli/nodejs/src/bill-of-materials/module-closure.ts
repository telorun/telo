/**
 * The module closure a bill of materials covers (`kernel/specs/module-artifact.md`
 * §7.7): every module an application runs — its own local modules, each
 * imported artifact, the modules nested in one, and every child application a
 * resource names at an `x-telo-application-source` field — each with its record
 * and with where a finding about it is reported.
 *
 * `telo sbom` composes it into one document; `telo audit` judges the same
 * closure, so both read one walk.
 */

import {
  BILL_OF_MATERIALS_FILE,
  DiagnosticSeverity,
  isArtifactRecordRole,
  parseLayerIndex,
  singletonLayer,
  readBillOfMaterials,
  analyzeLoadedGraph,
  collectModuleFileClaims,
  describeModuleSource,
  incompleteLayersOf,
  isModuleKind,
  isOciRef,
  moduleOrigins,
  nestedModuleOrigin,
  readModuleSources,
  sha256Base64Url,
  splitIntegrity,
  type AnalysisDiagnostic,
  type ApplicationSourceLoad,
  type ArtifactLayer,
  type BillOfMaterials,
  type CycloneDxComponent,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
  type ModuleOrigin,
  type ModuleSource,
  type RecordSubject,
} from "@telorun/analyzer";
import { isPayloadLink, nodeHostVersions, readOwnerManifest, readStoredLayer, resolveCacheRoot } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFIX, moduleSourceOf } from "../package/app-payload.js";
import {
  readArtifactBillOfMaterials,
  recordSubjectOf,
  type UnattributedInput,
} from "../bundle/module-bill-of-materials.js";
import { ModulePayloadBuilder } from "../bundle/module-payload.js";
import { cacheTargetFor, loadFreshGraph, openSession, type CheckSession } from "../check-session.js";
import { verdictStoreFor } from "../dependency-verdict-store.js";
import type { Logger } from "../logger.js";
import { resolveManifestInput, type ManifestInput, type PackagedInput } from "../manifest-input.js";
import { derivationRoot } from "./derivation-root.js";
import { scopedRecord, type OccurrenceScope } from "./platform-scope.js";

/** One import on the way from the application to a module, as written. */
export interface ImportLink {
  /** The alias the importer wrote (a child application's: the resource running it). */
  readonly alias: string;
  /** The source as written, without its pin; a nested module named by its parent. */
  readonly source: string;
  /** The imported module's `metadata.name`. */
  readonly module: string;
}

/** Where a finding about a module is reported, as an analysis diagnostic's
 *  `data` locates it in `graph`. */
export interface ClosureAnchor {
  readonly graph: LoadedGraph;
  readonly entryPath: string;
  readonly data: {
    readonly filePath?: string;
    readonly path?: string;
    readonly resource?: { readonly kind: string; readonly name: string };
  };
}

/** Why a module has no complete record. */
export type UnrecordedReason =
  /** Published before the record existed: a pre-layers artifact (`absent`), or
   *  a `layers:` index with no `sbom` layer. */
  | { readonly kind: "unpublished-record"; readonly index: "absent" | "no-sbom-layer" }
  /** The record carries `telo:incomplete` for these layers. */
  | {
      readonly kind: "incomplete";
      readonly layers: readonly string[];
      /** Bundle inputs no package claims, known for a module derived here. */
      readonly unattributed: readonly UnattributedInput[];
    }
  /** A local module a packaged executable carries built, its sources left behind. */
  /** A local module of a packaged executable whose payload index records no
   *  record for it: packaged by a telo that did not write one. */
  | { readonly kind: "packaged-without-record" };

export interface ClosureModule {
  /** The node's `bom-ref`: the integrity pin, or a local module's path relative
   *  to the entry's directory. */
  readonly ref: string;
  /** Read off the module's own `telo.yaml`. */
  readonly subject: RecordSubject;
  /** Reached from the entry through filesystem-path imports alone: derived here. */
  readonly local: boolean;
  /** The imports from the nearest local module to this one; empty for a local one. */
  readonly chain: readonly ImportLink[];
  /** A local module's `sources:` block, as its own document declares it; empty for an artifact. */
  readonly sources: readonly ModuleSource[];
  readonly anchor: ClosureAnchor;
  /** The module nodes it imports or runs, by `bom-ref`, in the order written. */
  readonly dependsOn: string[];
  /** Its complete record, absent when {@link unrecorded} says why. */
  record?: BillOfMaterials;
  /** The record's components within the platform scope, unqualified. */
  components: CycloneDxComponent[];
  /** The record's contains edges within the scope, unqualified. */
  contains: Map<string, string[]>;
  unrecorded?: UnrecordedReason;
}

export interface ApplicationClosure {
  /** The subject: the entry module. */
  readonly entry: ClosureModule;
  /** Every module node, the entry first, in the order the walk reached them. */
  readonly modules: readonly ClosureModule[];
  readonly scope: OccurrenceScope;
}

/** What keeps a closure from being built: diagnostics to print against `graph`. */
export interface ClosureRefusal {
  readonly graph?: LoadedGraph;
  readonly entryPath: string;
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

export type ClosureOutcome =
  | { readonly ok: true; readonly closure: ApplicationClosure }
  | { readonly ok: false; readonly refusals: readonly ClosureRefusal[] };

const isRemoteRef = (ref: string): boolean =>
  isOciRef(ref) || ref.startsWith("http://") || ref.startsWith("https://");

function localPathOf(source: string): string | null {
  if (source.startsWith("file://")) return fileURLToPath(source);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? null : source;
}

function moduleDocOf(file: LoadedFile): Record<string, unknown> | undefined {
  return file.manifests.find((m) => m && isModuleKind(m.kind as string)) as Record<string, unknown> | undefined;
}

/** A local module's `bom-ref`: its path relative to the entry's directory, a
 *  `telo.yaml` named by its directory, `#` and `%` percent-encoded. */
export function localModuleRef(entryDir: string, manifestPath: string): string {
  const named = path.basename(manifestPath) === "telo.yaml" ? path.dirname(manifestPath) : manifestPath;
  const rel = path.relative(entryDir, named).split(path.sep).join("/");
  const spelled = rel === "" ? "./" : rel.startsWith("../") || rel === ".." ? rel : `./${rel}`;
  return spelled.replace(/%/g, "%25").replace(/#/g, "%23");
}

async function pinOf(written: string | undefined, file: LoadedFile): Promise<string> {
  const pin = written ? splitIntegrity(written).integrity : undefined;
  return pin ?? `sha256-${await sha256Base64Url(new TextEncoder().encode(file.text))}`;
}

/** The source a chain names a module by: as requested, without its pin, or a
 *  nested module by its parent as written. */
function displaySource(graph: LoadedGraph, module: LoadedModule): string {
  return nestedModuleOrigin(graph, module.owner.source)
    ? describeModuleSource(graph, module.owner.source)
    : splitIntegrity(module.owner.requestedUrl).base;
}

/** The place of the first string equal to `value` beneath a top-level document,
 *  dotted as `data.path` reads it. */
function placeOfString(manifests: LoadedFile["manifests"], value: string): ClosureAnchor["data"] | undefined {
  const visit = (node: unknown, at: string): string | undefined => {
    if (node === value) return at;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const found = visit(node[i], `${at}[${i}]`);
        if (found !== undefined) return found;
      }
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const found = visit(child, at ? `${at}.${key}` : key);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const manifest of manifests) {
    if (!manifest || typeof manifest.kind !== "string") continue;
    const name = manifest.metadata?.name;
    if (typeof name !== "string") continue;
    const at = visit({ ...manifest, metadata: undefined }, "");
    if (at !== undefined) return { resource: { kind: manifest.kind, name }, path: at };
  }
  return undefined;
}

interface GraphScope {
  readonly graph: LoadedGraph;
  readonly origins: Map<string, ModuleOrigin>;
}

interface Reach {
  readonly importer?: ClosureModule;
  /** The import's source as written, for its pin. */
  readonly written?: string;
  readonly link?: ImportLink;
  /** Where the import reaching an artifact from a local module is written. */
  readonly anchor?: ClosureAnchor["data"];
  readonly chain: readonly ImportLink[];
  readonly local: boolean;
}

/**
 * Load, check and walk an application's closure, then read each module's
 * record within `scope`. A graph `telo check` refuses, and a local module
 * whose build fails, are refusals; a module with no complete record is in the
 * closure, marked {@link ClosureModule.unrecorded}, for the caller to judge.
 */
export async function buildApplicationClosure(options: {
  readonly manifest: string;
  readonly scope: OccurrenceScope;
  readonly log: Logger;
  /** `false` loads the graph and walks its edges without judging it as `telo
   *  check` does — for a synthetic root, whose own check says nothing about
   *  the module it imports (a library's required inputs go unsupplied there).
   *  A graph that failed to load is refused either way. */
  readonly check?: boolean;
}): Promise<ClosureOutcome> {
  const { scope, log } = options;
  let input: ManifestInput;
  try {
    input = await resolveManifestInput(options.manifest);
  } catch (err) {
    return refusal(options.manifest, undefined, err);
  }
  const target = cacheTargetFor(input);
  const session = openSession(target ? [target] : []);
  let graph: LoadedGraph;
  try {
    ({ graph } = await loadFreshGraph(input.entryPath, session, log));
  } catch (err) {
    return refusal(input.entryPath, undefined, err);
  }
  const refusals: ClosureRefusal[] = [];
  if (options.check === false) {
    if (graph.errors.length > 0) {
      return {
        ok: false,
        refusals: [
          {
            graph,
            entryPath: input.entryPath,
            diagnostics: graph.errors.map((entry) =>
              located(entry.error instanceof Error ? entry.error.message : String(entry.error), {}),
            ),
          },
        ],
      };
    }
  } else {
    const checked = await checkRefusal(graph, input, log);
    if (checked) return { ok: false, refusals: [checked] };
  }

  const entryPath = input.entryPath;
  const entryDir = path.dirname(localPathOf(graph.rootSource) ?? entryPath);
  const modules = new Map<string, ClosureModule>();
  const order: ClosureModule[] = [];
  const localManifests = new Map<ClosureModule, string>();

  const originsOf = (g: LoadedGraph, local: boolean): Map<string, ModuleOrigin> => {
    if (local) return moduleOrigins(g);
    return new Map([...g.modules.keys()].map((key) => [key, "artifact" as const]));
  };

  const childRoots = new Set<string>([graph.rootSource]);
  const queue: Array<{ scope: GraphScope; source: string; reach: Reach }> = [
    {
      scope: { graph, origins: originsOf(graph, !isRemoteRef(graph.entry.owner.requestedUrl)) },
      source: graph.rootSource,
      reach: { chain: [], local: !isRemoteRef(graph.entry.owner.requestedUrl) },
    },
  ];

  for (let item = queue.shift(); item; item = queue.shift()) {
    const { scope: at, source, reach } = item;
    const module = at.graph.modules.get(source);
    if (!module) continue;
    const local = reach.local && at.origins.get(source) === "editable";
    const manifestPath = local ? localPathOf(module.owner.source) : null;
    const ref = manifestPath
      ? localModuleRef(entryDir, manifestPath)
      : await pinOf(reach.written ?? module.owner.requestedUrl, module.owner);
    const known = modules.get(ref);
    if (known) {
      if (reach.importer && !reach.importer.dependsOn.includes(ref)) reach.importer.dependsOn.push(ref);
      continue;
    }
    const moduleDoc = moduleDocOf(module.owner);
    const docName = (moduleDoc?.metadata as { name?: unknown } | undefined)?.name;
    // A local module is reported at its own document; an artifact at the import
    // a local module wrote to reach it, or where its importer is reported.
    const anchor: ClosureAnchor = manifestPath
      ? {
          graph: at.graph,
          entryPath,
          data: {
            filePath: module.owner.source,
            ...(moduleDoc ? { resource: { kind: String(moduleDoc.kind), name: String(docName) } } : {}),
          },
        }
      : reach.anchor
        ? { graph: at.graph, entryPath, data: reach.anchor }
        : (reach.importer?.anchor ?? { graph: at.graph, entryPath, data: { filePath: module.owner.source } });
    const node: ClosureModule = {
      ref,
      subject: recordSubjectOf(moduleDoc),
      local: manifestPath !== null,
      chain: manifestPath ? [] : reach.link ? [...reach.chain, reach.link] : reach.chain,
      sources: manifestPath && moduleDoc ? readModuleSources(moduleDoc).sources : [],
      anchor,
      dependsOn: [],
      components: [],
      contains: new Map(),
    };
    moduleOfNode.set(node, module);
    modules.set(ref, node);
    order.push(node);
    if (manifestPath) localManifests.set(node, manifestPath);
    if (reach.importer && !reach.importer.dependsOn.includes(ref)) reach.importer.dependsOn.push(ref);

    const files = [module.owner, ...module.partials];
    // `imports:` first, then the imports scope members declare, each in order.
    for (const file of files) {
      for (const [alias, edge] of at.graph.importEdges.get(file.source) ?? []) {
        const targetModule = at.graph.modules.get(edge.targetSource);
        if (!targetModule) continue;
        queue.push({
          scope: at,
          source: edge.targetSource,
          reach: nextReach(node, at, targetModule, edge.targetRef, alias, {
            filePath: file.source,
            path: `imports.${alias}`,
          }),
        });
      }
    }
    for (const file of files) {
      for (const edge of at.graph.scopedImportEdges?.get(file.source) ?? []) {
        const targetModule = at.graph.modules.get(edge.targetSource);
        if (!targetModule) continue;
        queue.push({
          scope: at,
          source: edge.targetSource,
          reach: nextReach(node, at, targetModule, edge.targetRef, edge.alias, {
            filePath: file.source,
            resource: { kind: edge.holderKind, name: edge.holders[0]?.name ?? edge.alias },
            path: edge.holders.map((step) => `${step.field}[${step.index}]`).join("."),
          }),
        });
      }
    }

    // Every child application a resource of this module runs.
    for (const file of files) {
      const loads: Map<string, ApplicationSourceLoad> | undefined =
        at.graph.applicationSources?.get(file.source) ?? at.graph.moduleApplicationSources?.get(file.source);
      for (const [written, load] of loads ?? []) {
        if ("failure" in load) {
          refusals.push({
            graph: at.graph,
            entryPath,
            diagnostics: [
              located(
                `the child application '${written}' could not be loaded: ${load.failure.error.message}`,
                { filePath: file.source, ...placeOfString(file.manifests, written) },
              ),
            ],
          });
          continue;
        }
        const requested = load.graph.entry.owner.requestedUrl;
        const childLocal = node.local && !isRemoteRef(requested);
        const childGraph = await loadChild(session, load.graph, log);
        if (childRoots.has(childGraph.rootSource)) continue;
        childRoots.add(childGraph.rootSource);
        if (childLocal) {
          const childRefusal = await checkRefusal(childGraph, input, log);
          if (childRefusal) return { ok: false, refusals: [childRefusal] };
        }
        const childModule = childGraph.modules.get(childGraph.rootSource)!;
        const name = String(
          (moduleDocOf(childModule.owner)?.metadata as { name?: unknown } | undefined)?.name ?? written,
        );
        const holder = placeOfString(file.manifests, written);
        queue.push({
          scope: { graph: childGraph, origins: originsOf(childGraph, childLocal) },
          source: childGraph.rootSource,
          reach: {
            importer: node,
            written: requested,
            link: {
              alias: holder?.resource?.name ?? written,
              source: splitIntegrity(requested).base,
              module: name,
            },
            ...(node.local && !childLocal ? { anchor: { filePath: file.source, ...holder } } : {}),
            chain: node.local ? [] : node.chain,
            local: childLocal,
          },
        });
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const builder = new ModulePayloadBuilder({
    cacheRoot: input.cacheSealed ? workingCacheRoot() : (input.cacheRoot ?? workingCacheRoot()),
  });
  const failures: ClosureRefusal[] = [];
  for (const node of order) {
    const manifestPath = localManifests.get(node);
    if (manifestPath) {
      const failure = await readLocalRecord(node, manifestPath, {
        builder,
        packaged: input.packaged,
        rootOf: (file) => derivationRoot(file, entryDir, [...localManifests.values()]),
        scope,
      });
      if (failure) failures.push(failure);
      continue;
    }
    const failure = await readPublishedRecord(node, moduleOfNode.get(node)!, { input, scope });
    if (failure) failures.push(failure);
  }
  if (failures.length > 0) return { ok: false, refusals: failures };

  return { ok: true, closure: { entry: order[0]!, modules: order, scope } };

  function nextReach(
    from: ClosureModule,
    at: GraphScope,
    target: LoadedModule,
    written: string,
    alias: string,
    anchor: ClosureAnchor["data"],
  ): Reach {
    const targetLocal = from.local && at.origins.get(target.owner.source) === "editable";
    return {
      importer: from,
      written,
      link: {
        alias,
        source: displaySource(at.graph, target),
        module: String((moduleDocOf(target.owner)?.metadata as { name?: unknown } | undefined)?.name ?? alias),
      },
      ...(from.local && !targetLocal ? { anchor } : {}),
      chain: from.local ? [] : from.chain,
      local: targetLocal,
    };
  }
}

/** Each node's loaded module, recorded as the walk creates it. */
const moduleOfNode = new WeakMap<ClosureModule, LoadedModule>();

function workingCacheRoot(): string {
  return resolveCacheRoot(path.join(process.cwd(), "telo.yaml")) ?? path.join(process.cwd(), ".telo", "cache");
}

function located(message: string, data: ClosureAnchor["data"], code?: string): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    ...(code ? { code } : {}),
    source: "telo-sbom",
    message,
    data,
  };
}

function refusal(entryPath: string, graph: LoadedGraph | undefined, err: unknown): ClosureOutcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  return {
    ok: false,
    refusals: [
      {
        ...(graph ? { graph } : {}),
        entryPath,
        diagnostics: [
          located(err instanceof Error ? err.message : String(err), {}, typeof code === "string" ? code : undefined),
        ],
      },
    ],
  };
}

/** The graph's `telo check` refusal: every diagnostic of it when any is an error. */
async function checkRefusal(graph: LoadedGraph, input: ManifestInput, log: Logger): Promise<ClosureRefusal | undefined> {
  const store = verdictStoreFor(input, false, log);
  const analyzed = await analyzeLoadedGraph(graph, {
    hostVersions: nodeHostVersions(),
    ...(store ? { store } : {}),
  });
  const errors = analyzed.diagnostics.filter(
    (d) => (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error,
  );
  if (errors.length === 0) return undefined;
  return { graph, entryPath: input.entryPath, diagnostics: analyzed.diagnostics };
}

/** A child application's own graph, loaded again so its own children are seen. */
async function loadChild(session: CheckSession, handed: LoadedGraph, log: Logger): Promise<LoadedGraph> {
  const requested = handed.entry.owner.requestedUrl;
  const at = isRemoteRef(requested) ? requested : (localPathOf(handed.rootSource) ?? handed.rootSource);
  return (await loadFreshGraph(at, session, log)).graph;
}

async function readLocalRecord(
  node: ClosureModule,
  manifestPath: string,
  options: {
    readonly builder: ModulePayloadBuilder;
    readonly packaged?: PackagedInput;
    readonly rootOf: (file: string) => string | undefined;
    readonly scope: OccurrenceScope;
  },
): Promise<ClosureRefusal | undefined> {
  if (options.packaged) return readPackagedRecord(node, manifestPath, options.packaged, options.scope);
  const text = fs.readFileSync(manifestPath, "utf8");
  const claims = collectModuleFileClaims(text);
  try {
    const derived = await options.builder.derivedBillOfMaterials(manifestPath, options.rootOf(manifestPath));
    const incomplete = incompleteLayersOf(derived.record);
    if (incomplete.length > 0) {
      node.unrecorded = { kind: "incomplete", layers: incomplete, unattributed: derived.unattributed };
      return undefined;
    }
    accept(node, derived.record, options.scope);
    return undefined;
  } catch (err) {
    return {
      graph: node.anchor.graph,
      entryPath: node.anchor.entryPath,
      diagnostics: [buildFailure(node, manifestPath, claims, err)],
    };
  }
}

/**
 * A packaged executable's local module: its record is read from the payload's
 * sealed layer store — the layer the payload index names, its integrity
 * re-derived from the directory — and nothing is built, fetched or written.
 * A named layer that is missing or no longer verifies is a refusal no flag
 * passes; an entry with no `layers` was packaged without a record.
 */
async function readPackagedRecord(
  node: ClosureModule,
  manifestPath: string,
  packaged: PackagedInput,
  scope: OccurrenceScope,
): Promise<ClosureRefusal | undefined> {
  const source = moduleSourceOf(path.relative(path.join(packaged.dir, APP_PREFIX), manifestPath));
  const entry = packaged.index.modules.find((module) => module.delivery === "local" && module.source === source);
  const refuse = (reason: string): ClosureRefusal => ({
    graph: node.anchor.graph,
    entryPath: node.anchor.entryPath,
    diagnostics: [
      located(
        `the software bill of materials of ${node.subject.name} (${node.ref}) could not be read from the packaged ` +
          `executable ${packaged.executable}: ${reason} Package the application again.`,
        node.anchor.data,
      ),
    ],
  });
  if (!entry || entry.layers === undefined) {
    node.unrecorded = { kind: "packaged-without-record" };
    return undefined;
  }
  let layer;
  try {
    const layers = parseLayerIndex(entry.layers, `modules[${source}].layers`);
    const foreign = layers.find((candidate) => !isArtifactRecordRole(candidate.role));
    if (foreign) {
      return refuse(`its payload index lists a '${foreign.role}' layer, which holds a module file and has no place in a module's own record.`);
    }
    layer = singletonLayer(layers, "sbom");
  } catch (err) {
    return refuse(`its payload index entry is malformed (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!layer) {
    node.unrecorded = { kind: "packaged-without-record" };
    return undefined;
  }
  const stored = await readStoredLayer(packaged.cacheDir, layer, { removeStale: false });
  if (!stored) {
    return refuse(
      `the payload's layer store holds no ${layer.blob} directory that matches the integrity ${layer.integrity} ` +
        `its index records (it is missing or was edited).`,
    );
  }
  const file = stored.files.find((candidate) => candidate.name === BILL_OF_MATERIALS_FILE);
  if (!file || isPayloadLink(file) || stored.files.length !== 1) {
    return refuse(`its record layer must hold exactly one file, ${BILL_OF_MATERIALS_FILE}.`);
  }
  let record: BillOfMaterials;
  try {
    record = readBillOfMaterials(new TextDecoder("utf-8", { fatal: true }).decode(file.content), `the sbom layer of ${node.subject.name}`);
  } catch (err) {
    return refuse(`its record does not read (${err instanceof Error ? err.message : String(err)}).`);
  }
  const incomplete = incompleteLayersOf(record);
  if (incomplete.length > 0) {
    node.unrecorded = { kind: "incomplete", layers: incomplete, unattributed: [] };
    return undefined;
  }
  accept(node, record, scope);
  return undefined;
}

/** A local module's build failure, at the definition whose controller it is
 *  when the build names its entry point, else at the module document. */
function buildFailure(
  node: ClosureModule,
  manifestPath: string,
  claims: ReturnType<typeof collectModuleFileClaims>,
  err: unknown,
): AnalysisDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  const dir = path.dirname(manifestPath);
  const failed = claims.find(
    (claim) =>
      (claim.role === "controller" || claim.role === "library" || claim.role === "browser") &&
      claim.localPath !== undefined &&
      message.includes(path.resolve(dir, claim.localPath)),
  );
  const module = moduleOfNode.get(node);
  let data: ClosureAnchor["data"] = node.anchor.data;
  if (failed && module) {
    for (const file of [module.owner, ...module.partials]) {
      const holder = file.manifests.find(
        (m) =>
          m &&
          (failed.role === "controller"
            ? m.kind === "Telo.Definition" && JSON.stringify((m as { controllers?: unknown }).controllers ?? []).includes(failed.origin)
            : isModuleKind(m.kind as string)),
      );
      if (!holder) continue;
      data = {
        filePath: file.source,
        resource: { kind: String(holder.kind), name: String(holder.metadata?.name) },
        path: failed.role === "controller" ? "controllers" : "exports",
      };
      break;
    }
  }
  return located(
    `${node.subject.name} (${node.ref}) could not be built, so what it ships cannot be listed: ${message}`,
    data,
    typeof code === "string" ? code : undefined,
  );
}

async function readPublishedRecord(
  node: ClosureModule,
  module: LoadedModule,
  options: { readonly input: ManifestInput; readonly scope: OccurrenceScope },
): Promise<ClosureRefusal | undefined> {
  const owner = readOwnerManifest(module.owner.text);
  if (!owner.layers) {
    node.unrecorded = { kind: "unpublished-record", index: "absent" };
    return undefined;
  }
  try {
    const read = await readArtifactBillOfMaterials({
      pinnedRef: module.owner.requestedUrl,
      layers: owner.layers,
      // A packaged payload's store is read and never written: a miss or a copy
      // that no longer verifies is fetched into the working directory's cache.
      cacheRoot: options.input.cacheSealed ? workingCacheRoot() : (options.input.cacheRoot ?? workingCacheRoot()),
      ...(options.input.cacheSealed && options.input.cacheRoot ? { sealedRoot: options.input.cacheRoot } : {}),
    });
    if (!read) {
      node.unrecorded = { kind: "unpublished-record", index: "no-sbom-layer" };
      return undefined;
    }
    const incomplete = incompleteLayersOf(read.record);
    if (incomplete.length > 0) {
      node.unrecorded = { kind: "incomplete", layers: incomplete, unattributed: [] };
      return undefined;
    }
    accept(node, read.record, options.scope);
    return undefined;
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    return {
      graph: node.anchor.graph,
      entryPath: node.anchor.entryPath,
      diagnostics: [
        located(
          `the software bill of materials of ${module.owner.requestedUrl} could not be read: ` +
            (err instanceof Error ? err.message : String(err)),
          node.anchor.data,
          typeof code === "string" ? code : undefined,
        ),
      ],
    };
  }
}

function accept(node: ClosureModule, record: BillOfMaterials, scope: OccurrenceScope): void {
  const scoped = scopedRecord(record, scope);
  node.record = record;
  node.components = scoped.components;
  node.contains = scoped.contains;
}
