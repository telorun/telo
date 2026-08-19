/**
 * Static checks over durable regions — everything that keys off the `replayed`
 * and `idempotent` zone attributes.
 *
 * All of them are consumers of the ONE containment walk
 * (`resolve-zone-containment.ts`), parameterized over the attribute that opens
 * the region. The zones differ in what they forbid, not in how their contents
 * are found, and no check here names a kind: `modules/durable` is not part of
 * the analyzer's surface, which is what the topology-driven constraint requires
 * and what makes going native cost a module rather than an analyzer change.
 *
 * **Enforced at runtime, warned early.** Every rule below may under-approximate
 * — an edge the call graph cannot see is invisible here — and the runtime is the
 * real enforcement. The static half moves a failure to `telo check` for the
 * paths it can see, which is worth having and is not a guarantee. Where a rule
 * cannot be sound it is a warning rather than an error.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isCompiledValue, VALUE_TYPES } from "@telorun/sdk";
import { auditCalls, buildCelEnvironment, isTaggedSentinel, CEL_ENGINE } from "@telorun/templating";
import type { CallGraph, CallGraphNode, StepGraphNode } from "./call-graph.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import {
  findZoneRegions,
  type DefinitionLookup,
  type ZoneRegion,
} from "./resolve-zone-containment.js";

const SOURCE = "telo";

/**
 * The impure functions one CEL source actually CALLS, in source order.
 *
 * Parsed, never text-matched. A regex over the source is wrong in both
 * directions and in exactly the ways this repo has already retired elsewhere:
 * it fires on a function name inside a string literal, on an unrelated receiver
 * method that happens to share a name, and on text inside an interpolation it
 * has no business reading — while `analyze` already returns every call site the
 * parser found, each carrying the `deterministic` flag resolved from the
 * registry. One expression, one verdict, and it is the engine's.
 *
 * `deterministic === false` specifically: `undefined` means the name resolved to
 * nothing, or to a function carrying no determinism metadata, and absent is not
 * "impure" any more than it is "pure" — a name the registry cannot account for
 * is `CEL_UNKNOWN_FUNCTION`'s to report, not this rule's to guess at.
 */
function impureCalls(source: string): string[] {
  let ast;
  try {
    ast = CEL_ENV.parse(source).ast;
  } catch {
    // Unparseable CEL is `CEL_SYNTAX_ERROR`'s to report, and it will be, from
    // the pass that owns the expression. Reporting nothing here is right:
    // guessing at the calls in text that does not parse is exactly the
    // text-matching this replaced.
    return [];
  }
  const names: string[] = [];
  for (const call of auditCalls(source, ast, CEL_ENV).calls) {
    if (call.deterministic === false && !names.includes(call.name)) names.push(call.name);
  }
  return names;
}

/** One environment for the whole pass: it carries the function registry, which
 *  is what resolves a call's determinism, and nothing manifest-specific — the
 *  typed scope belongs to the CEL validation pass, which asks a different
 *  question of the same expressions. */
const CEL_ENV = buildCelEnvironment();

/** Every CEL source string reachable in a value tree, with the path that holds
 *  it. Stops at nested `{ kind }` declarations, which belong to another
 *  resource. */
function celSources(value: unknown, path: string, out: Array<[string, string]>): void {
  // A raw `${{ }}` string, which is what a consumer holding an unprecompiled
  // manifest sees. Each interpolation is pushed SEPARATELY: the surrounding
  // literal text is not CEL, and handing the whole string to a CEL parser
  // fails — which would silently report no calls at all for every expression
  // written this way.
  if (typeof value === "string") {
    for (const expression of interpolatedExpressions(value)) out.push([path, expression]);
    return;
  }
  if (!value || typeof value !== "object") return;
  // By the time this pass runs the loader has PRECOMPILED every CEL slot, so the
  // common shape is a CompiledValue rather than a string or a tag sentinel.
  // Reading only the authored spellings is why this check was silent on every
  // manifest that reached it — the one shape it never met was the one it always
  // gets. An interpolated string keeps its expressions in `parts`, so those are
  // descended into rather than read off the joined source.
  if (isCompiledValue(value)) {
    if (typeof value.source === "string") out.push([path, value.source]);
    for (const [i, part] of (value.parts ?? []).entries()) {
      if (typeof part !== "string") celSources(part, `${path}[${i}]`, out);
    }
    return;
  }
  // An unprecompiled `!cel` tag — what a round-trip consumer (the editor) holds,
  // and what reaches this pass whenever precompilation was not requested. Read
  // through the templating predicates rather than by testing a marker key: the
  // sentinel's shape is that package's, and spelling it here is a second place
  // it would have to be kept right.
  if (isTaggedSentinel(value) && value.engine === CEL_ENGINE) {
    out.push([path, value.source]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => celSources(item, `${path}[${i}]`, out));
    return;
  }
  // STOP at a nested resource declaration. Skipping the `kind` key alone was not
  // that: it walked straight into the declaration's own configuration and
  // reported its CEL against the enclosing resource, which is both the wrong
  // anchor and a claim about a region that expression is not in. The boundary is
  // the presence of `kind`, the same line Phase-5 injection and the include walk
  // already draw.
  const record = value as Record<string, unknown>;
  if (path && typeof record.kind === "string") return;
  for (const [key, child] of Object.entries(record)) {
    if (key === "kind" || key === "metadata") continue;
    celSources(child, path ? `${path}.${key}` : key, out);
  }
}

/** The expressions inside a `${{ … }}` interpolated string, unwrapped. Balanced
 *  on `}}` rather than on the first `}`, so an expression containing a map
 *  literal is not cut in half. */
function interpolatedExpressions(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf("${{", at);
    if (open < 0) return out;
    const close = text.indexOf("}}", open + 3);
    if (close < 0) return out;
    const expression = text.slice(open + 3, close).trim();
    if (expression) out.push(expression);
    at = close + 2;
  }
}

/**
 * `DURABLE_NONDETERMINISM` — impure CEL inside an `idempotent` region.
 *
 * **It keys on `idempotent`, and only there does it say something true.** Impure
 * CEL in a *journaled* position is not a defect at all — it is the correct
 * semantic: `now()` in a step's inputs is recorded on first execution and
 * replayed identically, which is exactly what a durable timestamp should do.
 *
 * What makes the idempotent case different is that such a region re-runs on
 * resume with its prior effects INTACT, because nothing discarded them — the
 * region's whole claim is that re-running is a no-op. Impure CEL falsifies
 * exactly that claim: `uuid()` as a key writes record A on the first pass and
 * record B on the second, so the re-run is not a no-op and the assertion the
 * author signed is false. The diagnostic can therefore say precisely that.
 *
 * **`atomic` is the wrong trigger, in both directions.** Too wide: collapse
 * there is conditional on a runtime attestation, so a transaction sharing the
 * journal's own transaction is NOT collapsed and its decisions genuinely are
 * journaled — a static trigger would fire on the configuration this design
 * recommends. Too narrow: an atomic zone that does re-run is a RETRY, not a
 * replay — its effects were discarded, so a fresh timestamp is simply a fresh
 * attempt.
 */
function checkNondeterminism(
  region: ZoneRegion,
  graph: CallGraph,
  reportModules: ReadonlySet<string>,
  diagnostics: AnalysisDiagnostic[],
): void {
  for (const { node } of region.contents.values()) {
    const [manifest, base, prefix] = celScopeOf(node, graph);
    if (!manifest || !owned(manifest, reportModules)) continue;
    const found: Array<[string, string]> = [];
    celSources(base, prefix, found);
    for (const [path, source] of found) {
      for (const fn of impureCalls(source)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "DURABLE_NONDETERMINISM",
          source: SOURCE,
          message:
            `'${fn}()' is evaluated inside a region declared idempotent by ` +
            `${region.provider.kind} '${region.provider.name}' — "${region.reason}". A ` +
            `region with that claim re-runs on a resume with its earlier effects intact, ` +
            `so an expression that produces a different value each time makes the ` +
            `re-run something other than a no-op and the claim false. Pin the value ` +
            `once for the region instead of computing it per pass.`,
          data: {
            resource: { kind: manifest.kind, name: manifest.metadata?.name as string },
            filePath: (manifest.metadata as { source?: string } | undefined)?.source,
            path,
          },
        });
        // One diagnostic per expression: naming every impure call in a single
        // expression would repeat one fix several times.
        break;
      }
    }
  }
}

/**
 * `DURABLE_DETACH_FORBIDDEN` — a detached dispatch inside a `replayed` region.
 *
 * Journal-on-completion would record the DISPATCH as done while the work runs
 * on, so a resume skips it and a crash loses it — durability's exact inverse.
 *
 * The replacement is better than what it forbids, which is why this is an error
 * rather than a warning: what an author wants there is a nested durable run
 * started without awaiting, so the step's outcome is a journalable run id, the
 * child gets its own identity and its own durability, and nothing is lost on
 * either side. That is what Temporal's child workflows and Restate's one-way
 * send already are.
 *
 * It keys off the dispatch BEING detached rather than off any kind, so it covers
 * a detaching decorator's configured mode as readily as an explicit detach.
 */
function checkDetach(
  region: ZoneRegion,
  reportModules: ReadonlySet<string>,
  diagnostics: AnalysisDiagnostic[],
): void {
  for (const boundary of region.boundaries) {
    if (!boundary.escaping.includes("detached")) continue;
    if (!owned(boundary.from.manifest, reportModules)) continue;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "DURABLE_DETACH_FORBIDDEN",
      source: SOURCE,
      message:
        `${boundary.from.kind} '${boundary.from.name}' dispatches '${boundary.edge.slot}' ` +
        `detached inside a durable region (${region.provider.kind} ` +
        `'${region.provider.name}'). Progress is recorded when a step COMPLETES, so a ` +
        `detached dispatch would be recorded as done while its work was still running — ` +
        `a resume would skip it and a crash would lose it, which is the opposite of what ` +
        `durability provides. Start a nested durable run instead and let the step record ` +
        `its run id: the work keeps its own identity and its own recovery, and nothing is ` +
        `awaited.`,
      data: {
        resource: { kind: boundary.from.kind, name: boundary.from.name },
        filePath: (boundary.from.manifest.metadata as { source?: string } | undefined)?.source,
        path: boundary.edge.path,
      },
    });
  }
}

/**
 * `DURABLE_UNJOURNALABLE_RESULT` — a live value in a journaled position.
 *
 * A live handle is consumed by reading, so it exists exactly once and a
 * recording of it is a recording of nothing. The rule keys off the `live` field
 * of the value-type vocabulary rather than off a type NAME, for the reason that
 * vocabulary is data: a live type added later is covered by its entry alone, and
 * the analyzer names a representation rather than a type.
 *
 * A WARNING rather than an error, and the runtime is the gate: what a step
 * actually produces is only as knowable as its declared contract, and a kind
 * that declares none falls back to a permissive shape that proves nothing. The
 * runtime raises `ERR_DURABLE_UNJOURNALABLE_VALUE` at the step path that
 * produced the value, which is as actionable and is true regardless of what was
 * declared.
 */
function checkUnjournalableResults(
  region: ZoneRegion,
  resolveDef: DefinitionLookup,
  graph: CallGraph,
  reportModules: ReadonlySet<string>,
  diagnostics: AnalysisDiagnostic[],
): void {
  for (const { node } of region.contents.values()) {
    if (node.type !== "step") continue;
    for (const edge of graph.edgesFrom(node.id)) {
      const target = edge.to ? graph.nodes.get(edge.to) : undefined;
      if (!target || target.type !== "resource") continue;
      const def = resolveDef(
        target.kind,
        (target.manifest.metadata as { module?: string } | undefined)?.module,
      );
      const declared =
        (target.manifest as Record<string, unknown>).outputType ??
        (def as Record<string, unknown> | undefined)?.outputType;
      if (!isLiveSchema(declared)) continue;
      const owner = graph.nodes.get((node as StepGraphNode).owner);
      const manifest = owner?.type === "resource" ? owner.manifest : target.manifest;
      if (!owned(manifest, reportModules)) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        code: "DURABLE_UNJOURNALABLE_RESULT",
        source: SOURCE,
        message:
          `Step '${(node as StepGraphNode).name ?? (node as StepGraphNode).path}' invokes ` +
          `${target.kind} '${target.name}', whose declared output is a live value, inside a ` +
          `durable region (${region.provider.kind} '${region.provider.name}'). A live handle ` +
          `is produced by consuming it, so it cannot be recorded and replayed — the run will ` +
          `fail at this step with ERR_DURABLE_UNJOURNALABLE_VALUE. Collect what you need ` +
          `from it into a plain value inside the step, or move the streaming work outside ` +
          `the durable body.`,
        data: {
          resource: { kind: manifest.kind, name: manifest.metadata?.name as string },
          filePath: (manifest.metadata as { source?: string } | undefined)?.source,
          path: (node as StepGraphNode).path,
        },
      });
    }
  }
}

/** Is this declared type a live-representation value? Reads the annotation the
 *  vocabulary defines rather than testing against a type name. */
function isLiveSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const annotation = (schema as Record<string, unknown>)["x-telo-type"];
  const name =
    typeof annotation === "string"
      ? annotation
      : ((annotation as Record<string, unknown> | undefined)?.name as string | undefined);
  if (!name) {
    const inner = (schema as Record<string, unknown>).schema;
    return inner !== undefined && inner !== schema ? isLiveSchema(inner) : false;
  }
  // The one place a name is compared, and it is compared against the LIVE flag
  // of the vocabulary entry rather than against a literal — so this stays true
  // when a second live type is declared.
  return LIVE_TYPE_NAMES.has(name);
}

/** Names of the value types whose representation is live, derived from the
 *  vocabulary itself. A constant rather than one-shot mutable state: the
 *  vocabulary is fixed at module load, so there is nothing to initialize and
 *  nothing an initialization order could get wrong. */
const LIVE_TYPE_NAMES: ReadonlySet<string> = new Set(
  [...VALUE_TYPES.values()].filter((e) => e.live).map((e) => e.name),
);

/**
 * Where a node's CEL lives, and which manifest a diagnostic about it anchors on.
 *
 * A STEP is where most of a body's CEL actually is — a step's `inputs`, its
 * `when`, a branch predicate — and a step node carries no manifest of its own,
 * so it anchors on the resource whose body declares it. Reading only resource
 * nodes would have made this check silent for exactly the position it exists to
 * cover.
 */
function celScopeOf(
  node: CallGraphNode,
  graph: CallGraph,
): [ResourceManifest | undefined, unknown, string] {
  if (node.type === "resource") return [node.manifest, node.manifest, ""];
  const owner = graph.nodes.get(node.owner);
  const manifest = owner?.type === "resource" ? owner.manifest : undefined;
  return [manifest, node.step, node.path];
}

/**
 * Is this manifest the entry's to fix?
 *
 * Scoped by the manifest's own DECLARING MODULE, not by its file path: a
 * published dependency's body is not the consumer's to fix (the
 * `X_TELO_REF_UNRESOLVED` precedent), and a path is not the module — a fixture
 * nested under one module's directory belongs to its own.
 */
function owned(manifest: ResourceManifest, reportModules: ReadonlySet<string>): boolean {
  const module = (manifest.metadata as { module?: string } | undefined)?.module;
  return !module || reportModules.size === 0 || reportModules.has(module);
}

export interface DurableRegionArgs {
  graph: CallGraph;
  resolveDef: DefinitionLookup;
  /** Only report against modules the entry owns — a published dependency's body
   *  is not the consumer's to fix, the `X_TELO_REF_UNRESOLVED` precedent. */
  reportModules: ReadonlySet<string>;
}

/** Every durable-region diagnostic, over one graph. */
export function validateDurableRegions(args: DurableRegionArgs): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const region of findZoneRegions(args.graph, args.resolveDef, "replayed")) {
    checkDetach(region, args.reportModules, diagnostics);
    checkUnjournalableResults(
      region,
      args.resolveDef,
      args.graph,
      args.reportModules,
      diagnostics,
    );
  }
  for (const region of findZoneRegions(args.graph, args.resolveDef, "idempotent")) {
    checkNondeterminism(region, args.graph, args.reportModules, diagnostics);
  }

  return diagnostics;
}

/** Re-exported so a consumer can name a region without importing two files. */
export type { ZoneRegion };
