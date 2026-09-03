/**
 * The zone projection — a CONSUMER of the call-graph service, with no traversal
 * of its own (see `plans/execution-zones.md`): it filters the graph's edges by
 * `use`, propagates zone requirements callee→caller along `call` edges,
 * discharges them at providing slots under the correlation rule, and fires at
 * terminating edges and at boot.
 *
 * Polarity: zones UNDER-approximate. A requirement is asserted only where the
 * manifest states it, a correlation only where a key pointer resolves, and an
 * edge whose `use` is unknown neither propagates nor terminates — it warns.
 * The runtime (`requireZone`) stays the enforcement; a path this pass cannot
 * see degrades to the runtime error at the right place, never to silence.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import {
  buildCallGraph,
  type CallGraph,
  type CallGraphEdge,
  type ResourceGraphNode,
} from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  enclosingOf,
  propertySchemas,
  resolveLocalRef,
} from "./manifest-navigation.js";
import type { ZoneModuleDocuments } from "./zone-module-documents.js";
import { readProvidesZone, readRequiresZone } from "./zone-slot.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** One open requirement on a library's exported resource — the contract an
 *  importer must satisfy. Plain data, so it caches and crosses the
 *  per-library derivation boundary. */
export interface ZoneRequirementSpec {
  /** Canonical `<module>.<Kind>` of the required zone. */
  zone: string;
  /** Correlation identity — the resolved declaration site of the instance the
   *  requirement correlates on (see {@link correlationIdOf}). Absent =
   *  uncorrelated. */
  correlation?: string;
  /** Human label of the correlation target (`sqlite.Connection 'billingDb'`). */
  correlationLabel?: string;
  /** Bare name of the correlation target — what the export-satisfiability
   *  check compares against `exports.resources`. */
  correlationName?: string;
  reason?: string;
  /** Attributes the satisfying zone must declare. Carried across the export
   *  boundary with the rest of the requirement: a consumer discharging a
   *  library's open requirement must meet the same guarantee the library's own
   *  internals would have. */
  attributes?: string[];
  /** Label of the requiring resource (`sql.Command 'charge'`). */
  origin: string;
  /** Resource names on the propagation path so far, origin first. */
  via: string[];
}

/** Per-library derived export contracts: export name → open requirements. */
export type ZoneExportRequirements = Map<string, ZoneRequirementSpec[]>;

export interface ZoneExportCacheEntry {
  signature: string;
  exports: ZoneExportRequirements;
}

/**
 * Host-lifetime cache for per-library export derivation, keyed by the
 * library's source identity with a content signature guarding staleness. The
 * HOST owns it (the editor re-analyzes on every keystroke and must not rebuild
 * every dependency's graph each time); the CLI passes none. It deliberately
 * does not live in `AnalysisRegistry`, which the editor constructs fresh per
 * closure per run — a cache there dies at exactly the boundary it must cross.
 */
export type ZoneExportCache = Map<string, ZoneExportCacheEntry>;

interface Requirement {
  zone: string;
  /** Kinds that discharge it: the zone kind plus everything extending it. */
  accepted: ReadonlySet<string>;
  /** Attributes the discharging zone must declare — the GUARANTEE half of the
   *  requirement, checked at the slot that would otherwise discharge it. */
  attributes: string[];
  correlation?: string;
  correlationLabel?: string;
  correlationName?: string;
  reason?: string;
  origin: string;
  /** Identity for memoization / dedup: zone + correlation. */
  key: string;
}

interface ProjectionArgs {
  graph: CallGraph;
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  aliasesByModule: Map<string, AliasResolver>;
  /** Modules whose files diagnostics may be reported against (the analysis
   *  entry's own modules). Empty = derive-only, report nothing. */
  reportModules: ReadonlySet<string>;
  /** Extra requirements seeded at forwarded export nodes, keyed
   *  `${module}\0${name}` — an imported library's derived contracts. */
  seeds?: Map<string, ZoneRequirementSpec[]>;
  /** When set, record every requirement that reaches a module-level resource
   *  this returns an export name for. */
  exportOf?: (node: ResourceGraphNode) => string | undefined;
}

interface ProjectionResult {
  diagnostics: AnalysisDiagnostic[];
  openExports: ZoneExportRequirements;
}

/** Resolve a possibly alias-form kind to its definition in the DECLARING
 *  module's scope — the same layering `AnalysisRegistry.resolveDefinitionIn`
 *  uses. */
function definitionResolver(
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
) {
  return (kind: string, module?: string): ResourceDefinition | undefined => {
    const scope = (module ? aliasesByModule.get(module) : undefined) ?? aliases;
    const canonical = scope.resolveKind(kind);
    return defs.resolve(kind) ?? (canonical ? defs.resolve(canonical) : undefined);
  };
}

const canonicalOf = (def: ResourceDefinition): string =>
  `${def.metadata.module}.${def.metadata.name}`;

/**
 * Correlation identity — the resolved DECLARATION SITE, mirroring runtime
 * instance identity exactly. A named module-level resource is
 * `(declaring file, name)` — the file, not the owning module name, because a
 * re-exported instance is forwarded once per re-exporting module under that
 * module's name while its declaration site survives the copy. A
 * `with:`-scoped resource is its scope site plus name (one instance per scope
 * run); an inline declaration is its own generated node.
 */
function correlationIdOf(node: ResourceGraphNode): string {
  if (node.scoped) return `${node.scopeOwner}\0${node.scopeSite}\0${node.name}`;
  const source = (node.manifest.metadata as { source?: string } | undefined)?.source ?? "";
  return `${source}\0${node.name}`;
}

const labelOf = (node: ResourceGraphNode): string => `${node.kind} '${node.name}'`;

/** The schema node at a field-map path (`steps`, `routes[].handler`), following
 *  `[]` into `items`, `{}` into `additionalProperties` and local `$defs` refs —
 *  where a slot's zone annotations live. */
function schemaNodeAt(
  rootSchema: Record<string, any> | undefined,
  slotPath: string,
): Record<string, any> | undefined {
  if (!rootSchema) return undefined;
  let current: Record<string, any> | undefined = rootSchema;
  for (const segment of slotPath.split(".")) {
    if (!current) return undefined;
    const bare = segment.replace(/(\[\]|\{\})+$/g, "");
    let next: Record<string, any> | undefined = propertySchemas(current).find(
      ([k]) => k === bare,
    )?.[1];
    for (const marker of segment.slice(bare.length).match(/\[\]|\{\}/g) ?? []) {
      next = resolveLocalRef(
        marker === "[]"
          ? (next?.items as Record<string, any> | undefined)
          : (next?.additionalProperties as Record<string, any> | undefined),
        rootSchema,
      );
      if (!next || typeof next !== "object") return undefined;
    }
    current = resolveLocalRef(next, rootSchema);
  }
  return current;
}

/**
 * The LOCAL name a correlation-key hop resolves to, or undefined when the value
 * is not a reference or does not name something local.
 *
 * **A cross-module reference is undefined, deliberately**, matching the kernel's
 * `referencedName` exactly: `!ref Alias.name` names an instance in another
 * module's scope, and the only index available here is flat and
 * module-unscoped, so taking the bare name would bind to whatever local
 * resource happens to share it. Correlation is an identity comparison — binding
 * it to the wrong resource is worse than leaving it uncorrelated, which is the
 * under-approximating direction the whole pass leans on. `Self.` is a local
 * name written the long way and does resolve.
 *
 * This deliberately differs from `call-graph`'s `refTargetName`, which answers a
 * different question (what an EDGE points at, cross-module included, for a graph
 * whose consumers tolerate an unresolved target) — hence two functions rather
 * than one shared helper.
 */
function refName(value: unknown): string | undefined {
  if (isRefSentinel(value)) {
    const source = value.source;
    const dot = source.indexOf(".");
    if (dot <= 0) return source;
    return source.slice(0, dot) === "Self" ? source.slice(dot + 1) : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const pure =
    typeof v.kind === "string" &&
    typeof v.name === "string" &&
    Object.keys(v).every((k) => k === "kind" || k === "name" || k === "alias" || k === "__ref");
  if (!pure) return undefined;
  const alias = v.alias;
  if (typeof alias === "string" && alias !== "Self") return undefined;
  return v.name as string;
}

/**
 * Resolve an ordered correlation-key pointer list against a resource's
 * manifest, first hit winning — the static counterpart of the kernel's walk.
 * A pointer may traverse a `!ref` into the referenced resource's own manifest
 * (read field → resolve reference → read field); traversal is mechanical, so
 * no kind is named here. Returns undefined when nothing resolves — the
 * requirement then discharges uncorrelated, the under-approximating side.
 */
function resolveStaticKey(
  start: ResourceGraphNode,
  pointers: readonly string[],
  resolveName: (name: string, from: ResourceGraphNode) => ResourceGraphNode | undefined,
): ResourceGraphNode | undefined {
  for (const pointer of pointers) {
    if (!pointer.startsWith("/")) continue;
    let manifest: Record<string, unknown> | undefined = start.manifest as Record<string, unknown>;
    let context = start;
    let value: unknown = undefined;
    let failed = false;
    const segments = pointer.slice(1).split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!.replace(/~1/g, "/").replace(/~0/g, "~");
      if (i > 0) {
        // Traverse the previous hop's reference into its declaration.
        const name = refName(value);
        const target = name ? resolveName(name, context) : undefined;
        if (!target) {
          failed = true;
          break;
        }
        manifest = target.manifest as Record<string, unknown>;
        context = target;
      }
      value = manifest?.[segment];
      if (value === undefined || value === null) {
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const terminalName = refName(value);
    const target = terminalName ? resolveName(terminalName, context) : undefined;
    if (target) return target;
  }
  return undefined;
}

/** Anchor a provider-side single pointer at the object enclosing the slot,
 *  then resolve exactly like a requirer key. */
function resolveProviderKey(
  provider: ResourceGraphNode,
  edge: CallGraphEdge,
  pointer: string,
  resolveName: (name: string, from: ResourceGraphNode) => ResourceGraphNode | undefined,
): ResourceGraphNode | undefined {
  const enclosing = enclosingOf(provider.manifest, edge.path);
  if (enclosing === provider.manifest || enclosing === undefined) {
    return resolveStaticKey(provider, [pointer], resolveName);
  }
  // Slot inside an array item: resolve the first hop off the item, further
  // hops through references as usual.
  const synthetic: ResourceGraphNode = { ...provider, manifest: enclosing as ResourceManifest };
  return resolveStaticKey(synthetic, [pointer], resolveName);
}

/** Run the projection over one graph. */
export function projectZoneRequirements(args: ProjectionArgs): ProjectionResult {
  const { graph, defs, aliases, aliasesByModule, reportModules, seeds, exportOf } = args;
  const resolveDef = definitionResolver(defs, aliases, aliasesByModule);
  const diagnostics: AnalysisDiagnostic[] = [];
  const openExports: ZoneExportRequirements = new Map();
  const reported = new Set<string>();

  // Scope-local name index, so a scoped resource's pointers resolve against its
  // scope siblings first — the order `ScopeContext` and `!ref` agree on.
  const scopeLocal = new Map<string, Map<string, ResourceGraphNode>>();
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource" || !node.scoped) continue;
    const key = `${node.scopeOwner}\0${node.scopeSite}`;
    let bucket = scopeLocal.get(key);
    if (!bucket) scopeLocal.set(key, (bucket = new Map()));
    bucket.set(node.name, node);
  }
  const resolveName = (
    name: string,
    from: ResourceGraphNode,
  ): ResourceGraphNode | undefined => {
    if (from.scoped) {
      const local = scopeLocal.get(`${from.scopeOwner}\0${from.scopeSite}`)?.get(name);
      if (local) return local;
    }
    // In the scope that WROTE the name: a bare reference means the reader's own
    // module, and two libraries may each declare one.
    return graph.resourceByName(
      name,
      (from.manifest.metadata as { module?: string } | undefined)?.module,
    );
  };

  const acceptedFor = (zone: string): ReadonlySet<string> => {
    const out = new Set<string>([zone]);
    for (const def of defs.getByExtends(zone)) {
      const module = (def.metadata as { module?: string } | undefined)?.module;
      if (module && def.metadata?.name) out.add(`${module}.${def.metadata.name as string}`);
    }
    return out;
  };

  const moduleOf = (node: ResourceGraphNode): string | undefined =>
    (node.manifest.metadata as { module?: string } | undefined)?.module;

  const reportable = (node: ResourceGraphNode): boolean => {
    const module = moduleOf(node);
    return module === undefined || reportModules.has(module);
  };

  const emit = (
    severity: DiagnosticSeverity,
    code: string,
    edge: CallGraphEdge,
    caller: ResourceGraphNode,
    req: Requirement,
    via: string[],
    why: string,
  ): void => {
    if (!reportable(caller)) return;
    const dedupe = `${code}\0${edge.from}\0${edge.path}\0${req.key}`;
    if (reported.has(dedupe)) return;
    reported.add(dedupe);
    const wanted = req.correlationLabel
      ? `a ${req.zone} zone on ${req.correlationLabel}`
      : `a ${req.zone} zone`;
    const path = [...via, `${caller.name}.${edge.path}`].join(" → ");
    const reason = req.reason ? ` ${req.reason}.` : "";
    diagnostics.push({
      severity,
      code,
      source: SOURCE,
      message: `${req.origin} requires ${wanted}, and the path ${path} ${why}.${reason}`,
      data: {
        resource: { kind: caller.kind, name: caller.name },
        filePath: (caller.manifest.metadata as { source?: string } | undefined)?.source,
        path: edge.path,
      },
    });
  };

  const visited = new Set<string>();

  const propagate = (node: ResourceGraphNode, req: Requirement, via: string[]): void => {
    const visitKey = `${node.id}\0${req.key}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    // A requirement reaching an exported instance is part of that export's
    // contract — recorded, and propagation continues (the export may also be
    // reached internally, where an enclosing provider can discharge it).
    const exportName = exportOf?.(node);
    if (exportName !== undefined) {
      let bucket = openExports.get(exportName);
      if (!bucket) openExports.set(exportName, (bucket = []));
      if (!bucket.some((r) => `${r.zone}\0${r.correlation ?? ""}` === req.key)) {
        bucket.push({
          zone: req.zone,
          ...(req.attributes.length > 0 ? { attributes: req.attributes } : {}),
          correlation: req.correlation,
          correlationLabel: req.correlationLabel,
          correlationName: req.correlationName,
          reason: req.reason,
          origin: req.origin,
          via: [...via],
        });
      }
    }

    for (const edge of graph.edgesTo(node.id)) {
      const from = graph.nodes.get(edge.from);
      if (!from) continue;
      const caller =
        from.type === "step"
          ? (graph.nodes.get(from.owner) as ResourceGraphNode | undefined)
          : from;
      if (!caller || caller.type !== "resource") continue;

      // Discharge: the slot provides a zone whose kind satisfies the
      // requirement and whose correlation payload is the same declaration
      // site. Checked BEFORE termination, so a terminating provider slot
      // (a detached durable body) still discharges its own zone.
      const callerDef = resolveDef(caller.kind, moduleOf(caller));
      // WHICH slot establishes the zone depends on the body's SHAPE, and both
      // shapes are real. A ref body annotates the slot the edge itself names
      // (`Sql.Transaction.steps`, holding a `!ref` to an executable). A NATIVE
      // body annotates the step ARRAY, while the edge comes from a step inside
      // it and names that step's own `invoke:` — so looking only at `edge.slot`
      // finds no annotation and the enclosing zone never discharges anything.
      // Handling one shape would make every requirement inside a natively-bodied
      // zone unsatisfiable, which is exactly what a durable workflow's body is.
      const bodySlot =
        from.type === "step" ? from.array.replace(/\[\d+\].*$/, "") : edge.slot;
      const slotSchema = schemaNodeAt(
        callerDef?.schema as Record<string, any> | undefined,
        bodySlot,
      );
      const provides = readProvidesZone(slotSchema);
      if (provides && callerDef && req.accepted.has(canonicalOf(callerDef))) {
        // A native body's annotation sits on the array, whose enclosing object
        // IS the resource root — so its correlation pointer anchors there,
        // rather than at the step item the edge happens to come from.
        const providerKey = provides.key
          ? from.type === "step"
            ? resolveStaticKey(caller, [provides.key], resolveName)
            : resolveProviderKey(caller, edge, provides.key, resolveName)
          : undefined;
        const discharged =
          req.correlation === undefined ||
          (providerKey !== undefined && correlationIdOf(providerKey) === req.correlation);
        if (discharged) {
          // The zone is the right KIND but may not make the promise the
          // requirement is built on. Reported here rather than at the providing
          // module, because this is the only point where both halves are in
          // hand: the requirement's demanded attributes and the slot that would
          // satisfy it. The requirement still discharges — the zone IS open, so
          // reporting it unsatisfied as well would name the same defect twice
          // with opposite words.
          const missing = req.attributes.filter((a) => !(a in provides.attributes));
          if (missing.length > 0) {
            emit(
              DiagnosticSeverity.Error,
              "ZONE_ATTRIBUTE_MISSING",
              edge,
              caller,
              req,
              via,
              `reaches a ${canonicalOf(callerDef)} zone that does not declare ` +
                `${missing.join(", ")}, so the guarantee this requirement is built on ` +
                `does not hold inside it`,
            );
          }
          continue;
        }
      }

      // A dynamic selector is already a hard diagnostic (validate-ref-slots);
      // zones do not re-report it — and must not propagate through a use they
      // cannot read.
      if (edge.unresolvedReason === "dynamic") continue;

      if (edge.use.length === 0) {
        emit(
          DiagnosticSeverity.Warning,
          "ZONE_REQUIREMENT_DEFERRED",
          edge,
          caller,
          req,
          via,
          "reaches a slot that declares no use, so whether the zone survives it cannot be decided statically; the runtime check remains the enforcement",
        );
        continue;
      }
      if (edge.unresolved) {
        emit(
          DiagnosticSeverity.Warning,
          "ZONE_REQUIREMENT_DEFERRED",
          edge,
          caller,
          req,
          via,
          `reaches a slot whose use selector could not be resolved (${edge.unresolvedReason}), so whether the zone survives it cannot be decided statically; the runtime check remains the enforcement`,
        );
        continue;
      }
      if (edge.use.every((u) => u === "dependency" || u === "schema")) continue;

      if (edge.use.length > 1) {
        // The zone's lifetime extends through the edge only if EVERY member is
        // `call` — a set says several relations hold at once, not that one of
        // them might.
        if (edge.use.every((u) => u === "call")) {
          continueUp(caller, edge, req, via);
          continue;
        }
        // A member the runtime guarantees is cleared makes the set decidably
        // wrong, not undecidable: the detached dispatch is NEVER inside the
        // caller's zone, so the requirement — a universal claim — is violated
        // on that path. What stays unknown is only how often that path is
        // taken, and "sometimes throws" is not a working manifest.
        //
        // This is the one place the plan's original rule was inverted, and
        // deliberately. That rule existed to stop `Cache.View`'s UNCONDITIONAL
        // `[call, detached]` from hard-erroring every cached transactional call
        // under the default `revalidate: sync`, where the controller never
        // detaches — but the same change that added this pass re-annotated that
        // slot as a case map, so a set now appears only where its detach really
        // happens. The justification went with the annotation.
        const guaranteedCleared = edge.use.filter(
          (u) => u === "detached" || u === "trigger.inbound",
        );
        if (guaranteedCleared.length > 0) {
          emit(
            DiagnosticSeverity.Error,
            "ZONE_REQUIREMENT_UNSATISFIED",
            edge,
            caller,
            req,
            via,
            `reaches a slot that dispatches its target several ways in one invocation ([${edge.use.join(", ")}]), and the ${guaranteedCleared.join(" / ")} dispatch is guaranteed a fresh context — so on that path the zone is gone`,
          );
          continue;
        }
        // Everything else in a set is undecidable rather than wrong — a
        // `trigger.consumer` member means a drain site MIGHT be inside the
        // zone, which no static reading can settle.
        emit(
          DiagnosticSeverity.Warning,
          "ZONE_REQUIREMENT_DEFERRED",
          edge,
          caller,
          req,
          via,
          `reaches a slot whose declared use is the set [${edge.use.join(", ")}]; whether the zone survives depends on where the consumer drains it, so it cannot be decided statically and the runtime check remains the enforcement`,
        );
        continue;
      }

      switch (edge.use[0]) {
        case "call":
          continueUp(caller, edge, req, via);
          break;
        case "detached":
          emit(
            DiagnosticSeverity.Error,
            "ZONE_REQUIREMENT_UNSATISFIED",
            edge,
            caller,
            req,
            via,
            "detaches there — the runtime guarantees the detached work a fresh context, outside every zone its caller was in",
          );
          break;
        case "trigger.inbound":
          emit(
            DiagnosticSeverity.Error,
            "ZONE_REQUIREMENT_UNSATISFIED",
            edge,
            caller,
            req,
            via,
            "is an inbound trigger registration — the handler runs on a fresh context driven by a request or timer, outside every zone",
          );
          break;
        case "trigger.consumer":
          emit(
            DiagnosticSeverity.Warning,
            "ZONE_REQUIREMENT_DEFERRED",
            edge,
            caller,
            req,
            via,
            "is dispatched when a returned value is drained, so where it runs is the drain site's choice; the runtime check remains the enforcement",
          );
          break;
        // dependency / schema singletons were filtered above.
      }
    }
  };

  const continueUp = (
    caller: ResourceGraphNode,
    edge: CallGraphEdge,
    req: Requirement,
    via: string[],
  ): void => {
    // Nothing encloses an Application's boot targets: an open requirement
    // arriving there surfaces at boot.
    if (caller.kind === "Telo.Application") {
      emit(
        DiagnosticSeverity.Error,
        "ZONE_REQUIREMENT_UNSATISFIED",
        edge,
        caller,
        req,
        via,
        "reaches the application's boot targets, which nothing encloses",
      );
      return;
    }
    propagate(caller, req, [...via, caller.name]);
  };

  // ── Origins: instances of the entry graph whose annotated field is present.
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource") continue;
    const meta = node.manifest.metadata as
      | { module?: string; forwardedExport?: boolean }
      | undefined;
    // A forwarded export's requirements are derived by ITS library's own stage
    // (with the internal graph in hand) and seeded below — deriving them here
    // against the flattened view would resolve correlation against a graph
    // that no longer holds the library's internals.
    if (meta?.forwardedExport) continue;
    const def = resolveDef(node.kind, meta?.module);
    const schema = def?.schema as Record<string, any> | undefined;
    if (!def || !schema) continue;
    // A requirement at the SCHEMA ROOT is unconditional: every instance of the
    // kind must be inside the zone, whatever it is configured with. A parking
    // kind is exactly that shape — it has no option that turns the requirement
    // on — and a field-level annotation would have to be attached to some
    // arbitrary property and would then read "…when you set this one".
    const slots: [Record<string, any>, string | undefined][] = [[schema, undefined]];
    for (const [field, propSchema] of Object.entries(
      (schema.properties ?? {}) as Record<string, Record<string, any>>,
    )) {
      slots.push([propSchema, field]);
    }
    for (const [slotSchema, field] of slots) {
      const requires = readRequiresZone(slotSchema);
      if (!requires) continue;
      if (field !== undefined && (node.manifest as Record<string, unknown>)[field] === undefined) {
        continue;
      }
      const zoneDef = resolveDef(requires.zone, def.metadata.module);
      if (!zoneDef) continue; // ZONE_PROVIDER_UNRESOLVED is reported at registration
      const zone = canonicalOf(zoneDef);
      const target = resolveStaticKey(node, requires.key, resolveName);
      const req: Requirement = {
        zone,
        accepted: acceptedFor(zone),
        attributes: requires.attributes,
        correlation: target ? correlationIdOf(target) : undefined,
        correlationLabel: target ? labelOf(target) : undefined,
        correlationName: target?.name,
        reason: requires.reason,
        origin: labelOf(node),
        key: "",
      };
      req.key = `${req.zone}\0${req.correlation ?? ""}`;
      propagate(node, req, [node.name]);
    }
  }

  // ── Seeds: imported libraries' derived export contracts, attached at the
  // forwarded nodes the importer's graph actually holds.
  if (seeds && seeds.size > 0) {
    for (const node of graph.nodes.values()) {
      if (node.type !== "resource") continue;
      const meta = node.manifest.metadata as
        | { module?: string; forwardedExport?: boolean }
        | undefined;
      if (!meta?.forwardedExport || !meta.module) continue;
      const specs = seeds.get(`${meta.module}\0${node.name}`);
      if (!specs) continue;
      for (const spec of specs) {
        const zoneDef = defs.resolve(spec.zone);
        const req: Requirement = {
          zone: spec.zone,
          accepted: zoneDef ? acceptedFor(spec.zone) : new Set([spec.zone]),
          attributes: spec.attributes ?? [],
          correlation: spec.correlation,
          correlationLabel: spec.correlationLabel,
          correlationName: spec.correlationName,
          reason: spec.reason,
          origin: spec.origin,
          key: `${spec.zone}\0${spec.correlation ?? ""}`,
        };
        propagate(node, req, [...spec.via, node.name]);
      }
    }
  }

  return { diagnostics, openExports };
}

/** Content signature over a library's loaded documents — what makes a
 *  workspace library invalidate on the keystroke that changed it while a
 *  published library (immutable bytes) hits every time. FNV-1a over the JSON
 *  projection; collisions only stale a warning-level derivation, and the
 *  projection is cheap relative to the graph build it guards. */
export function zoneDocumentsSignature(manifests: readonly ResourceManifest[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const m of manifests) mix(JSON.stringify(m) ?? "");
  return (hash >>> 0).toString(16);
}

/**
 * Derive one library's export contracts: build the library-scoped graph from
 * its full documents (which the flattened analysis view no longer holds), run
 * the projection derive-only, and keep what reaches an exported instance.
 */
export function deriveLibraryExportRequirements(
  docs: ZoneModuleDocuments,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  cache?: ZoneExportCache,
): ZoneExportRequirements {
  const signature = docs.signature ?? zoneDocumentsSignature(docs.manifests);
  const cached = cache?.get(docs.sourceId);
  if (cached && cached.signature === signature) return cached.exports;

  const exported = new Set(docs.exportedNames);
  const graph = buildCallGraph(docs.manifests, defs, { aliases, aliasesByModule });
  const { openExports } = projectZoneRequirements({
    graph,
    defs,
    aliases,
    aliasesByModule,
    reportModules: new Set(),
    exportOf: (node) =>
      !node.scoped && exported.has(node.name) ? node.name : undefined,
  });
  cache?.set(docs.sourceId, { signature, exports: openExports });
  return openExports;
}

export interface ZoneAnalysisArgs {
  /** The entry analysis set (post inline-normalization + sentinel resolution). */
  manifests: ResourceManifest[];
  graph: CallGraph;
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  aliasesByModule: Map<string, AliasResolver>;
  rootModules: ReadonlySet<string>;
  moduleDocuments?: readonly ZoneModuleDocuments[];
  cache?: ZoneExportCache;
}

/**
 * The zone stage of `analyze()`: per-library export derivation (cached), the
 * entry projection with those contracts seeded, and — when the entry is a
 * library — the export-satisfiability check, at the one desk where it is
 * fixable.
 */
export function runZoneAnalysis(args: ZoneAnalysisArgs): AnalysisDiagnostic[] {
  const { manifests, graph, defs, aliases, aliasesByModule, rootModules } = args;

  // Per-library export contracts, derived over each library's own documents.
  const seeds = new Map<string, ZoneRequirementSpec[]>();
  for (const docs of args.moduleDocuments ?? []) {
    const contracts = deriveLibraryExportRequirements(
      docs,
      defs,
      aliases,
      aliasesByModule,
      args.cache,
    );
    for (const [exportName, specs] of contracts) {
      if (specs.length > 0) seeds.set(`${docs.module}\0${exportName}`, specs);
    }
  }

  // The entry library's own export surface, for the satisfiability check.
  const rootLibraries: Array<{ module: string; exportedNames: Set<string>; doc: ResourceManifest }> =
    [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Library") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name || !rootModules.has(name)) continue;
    const exportedNames = new Set<string>();
    for (const entry of (m as { exports?: { resources?: unknown[] } }).exports?.resources ?? []) {
      if (typeof entry !== "string") continue;
      const dot = entry.indexOf(".");
      exportedNames.add(dot > 0 ? entry.slice(dot + 1) : entry);
    }
    if (exportedNames.size > 0) rootLibraries.push({ module: name, exportedNames, doc: m });
  }
  const exportOf =
    rootLibraries.length > 0
      ? (node: ResourceGraphNode): string | undefined => {
          if (node.scoped) return undefined;
          const module = (node.manifest.metadata as { module?: string } | undefined)?.module;
          const lib = rootLibraries.find((l) => l.module === module);
          return lib?.exportedNames.has(node.name) ? node.name : undefined;
        }
      : undefined;

  const { diagnostics, openExports } = projectZoneRequirements({
    graph,
    defs,
    aliases,
    aliasesByModule,
    reportModules: rootModules,
    seeds: seeds.size > 0 ? seeds : undefined,
    exportOf,
  });

  // An export whose requirement correlates on a resource importers cannot
  // reach is unsatisfiable by construction — raised HERE, at the exporting
  // library, never by an importer against a file it does not own.
  for (const lib of rootLibraries) {
    for (const [exportName, specs] of openExports) {
      if (!lib.exportedNames.has(exportName)) continue;
      const node = graph.resourceByName(exportName, lib.module);
      if (!node || (node.manifest.metadata as { module?: string } | undefined)?.module !== lib.module) {
        continue;
      }
      for (const spec of specs) {
        if (spec.correlationName === undefined) continue; // uncorrelated — satisfiable by any zone
        if (lib.exportedNames.has(spec.correlationName)) continue; // importers can reach it
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "ZONE_EXPORT_UNSATISFIABLE",
          source: SOURCE,
          message:
            `exported resource '${exportName}' carries an open requirement: ${spec.origin} requires ` +
            `a ${spec.zone} zone on ${spec.correlationLabel}, which this library does not export — ` +
            `no importer can satisfy it. Export '${spec.correlationName}' too (importers wrap ` +
            `'${exportName}' in their own zone on it), or export a resource that goes through the ` +
            `provider instead of '${exportName}' directly.` +
            (spec.reason ? ` ${spec.reason}.` : ""),
          data: {
            resource: { kind: node.kind, name: node.name },
            filePath: (node.manifest.metadata as { source?: string } | undefined)?.source,
            path: "",
          },
        });
      }
    }
  }

  return diagnostics;
}
