import type { CelEnvironment } from "@telorun/cel";
import { isKindDocument } from "./kind-declaration.js";
import { isRefSentinel } from "@telorun/templating";
import {
  AMBIENT_CONTRACT_ERROR_CODES,
  isAmbientContractErrorCode,
  type ResourceManifest,
} from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { handsFailureBack, throwsUses, type ThrowsUnion } from "./resolve-throws-union.js";
import { forEachDeclaredSlot } from "./schema-walk.js";
import {
  CatchLadder,
  collectOutcomeLists,
  type CatchEntryReading,
  type CatchList,
  type OutcomeEntry,
} from "./catch-scope.js";
import type { ValidateFunction } from "ajv";
import { schemaIssues } from "./schema-error-report.js";
import { createAjv } from "./schema-compat.js";
import { builtinDocumentSchema } from "./builtins.js";
import { declarableCapabilities, throwsAllowedCapabilities } from "./capability-roster.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Rule 7: within an outcome list, a no-`when:` entry must be the last entry. */
function checkCatchAllPlacement(
  entries: OutcomeEntry[],
  resource: { kind: string; name: string },
  channel: "returns" | "catches",
  filePath: string | undefined,
  arrayPath: string,
  routing: { kind: string; name: string } = resource,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const e = entries[i];
    if (!e?.when) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "CATCHALL_NOT_LAST",
        source: SOURCE,
        message: `${channel}: catch-all entry (no \`when:\`) at index ${i} must be last — entries after it are unreachable.`,
        data: { resource: routing, filePath, path: `${arrayPath}[${i}]` },
      });
    }
  }
  return diagnostics;
}

/** Rule 4: a coverage-proving `when:` may only name a code the list's own
 *  denominator can produce. Runs for EVERY list, scope lists included — the
 *  denominator differs (a handler's union, or the enclosing resource's own), the
 *  typo check does not. */
function checkUndeclaredCodes(
  readings: readonly CatchEntryReading[],
  union: ThrowsUnion,
  filePath: string | undefined,
  arrayPath: string,
  denominator: string,
  routing: { kind: string; name: string },
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const declaredCodes = new Set(union.codes.keys());

  for (let i = 0; i < readings.length; i++) {
    const { catchAll, proven, codes } = readings[i]!;
    if (catchAll || !proven) continue;
    for (const c of codes) {
      // An ambient kernel code (contract violations) is raised by the kernel,
      // not declared by the kind, so naming it is legal and still typo-checked
      // — but it is NOT part of the declared union, so it never counts toward
      // coverage. Folding these into every union would make every bounded
      // catches: block in the standard library incomplete overnight.
      if (isAmbientContractErrorCode(c)) continue;
      if (declaredCodes.has(c)) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "UNDECLARED_THROW_CODE",
        source: SOURCE,
        message: `catches[${i}] references code '${c}' which is not in ${denominator} {${[...declaredCodes].sort().join(", ") || "∅"}} (ambient kernel codes ${AMBIENT_CONTRACT_ERROR_CODES.join(", ")} may also be named)${union.unbounded ? "; the union is unbounded, so a catch-all is required" : ""}.`,
        data: { resource: routing, filePath, path: `${arrayPath}[${i}].when` },
      });
    }
  }

  return diagnostics;
}

/** Rule 1 + the unbounded-union rule, asked ONCE per dispatch site over its
 *  catch ladder — the site's own list, its resource's scope list, and every
 *  scope enclosing that resource.
 *
 *  Asking it per list is what would make this a false check rather than a
 *  missing one: a route that declares no `catches:` under a router that renders
 *  everything is completely covered, and reporting it fires on precisely the
 *  manifests scope lists exist to enable. */
function checkCoverage(site: CatchList, union: ThrowsUnion, ladder: CatchLadder): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  const { routing, filePath, arrayPath } = site;

  // Unbounded union (passthrough or transitive): authors can't enumerate the
  // codes, so a catch-all is mandatory — at this list or any enclosing scope.
  if (union.unbounded && !ladder.ladderFor(site.manifest, site, null).covered) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "UNBOUNDED_UNION_NEEDS_CATCHALL",
      source: SOURCE,
      message: `The handler's throw union is unbounded (inherit/passthrough resolution couldn't enumerate all codes). A catch-all entry (no \`when:\`) is required — on this catches: list or on an enclosing one.`,
      data: { resource: routing, filePath, path: arrayPath },
    });
  }

  // One diagnostic per site, not per code: every uncovered code sits at the
  // same dispatch site, and one catch-all answers all of them at once. A
  // diagnostic each repeated the same location and the same fix N times.
  const uncovered = [...union.codes.keys()]
    .filter((c) => !ladder.ladderFor(site.manifest, site, c).covered)
    .sort();
  if (uncovered.length > 0) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "UNCOVERED_THROW_CODE",
      source: SOURCE,
      message:
        `handler ${handlerLabel(site.handler)} can throw ${uncovered.length} code${uncovered.length === 1 ? "" : "s"} that no catches: entry handles — at this list or any enclosing scope: ${uncovered.map((c) => `'${c}'`).join(", ")}. ` +
        `Give each a matching \`when:\`${site.codeChains[0] ? ` (e.g. \`when: !cel "${site.codeChains[0].join(".")} == '${uncovered[0]}'"\`)` : ""}, or add a catch-all entry — one with no \`when:\`, placed last.`,
      data: { resource: routing, filePath, path: arrayPath, uncovered },
    });
  }

  return diagnostics;
}

/** A handler as a message names it: `!ref <name>` for a reference, its kind
 *  for a kind string. */
function handlerLabel(handler: unknown): string {
  if (isRefSentinel(handler)) return `\`!ref ${handler.source}\``;
  if (handler && typeof handler === "object") {
    const { kind, name } = handler as { kind?: unknown; name?: unknown };
    if (typeof name === "string") return `\`!ref ${name}\``;
    if (typeof kind === "string") return `\`${kind}\``;
  }
  return typeof handler === "string" ? `\`${handler}\`` : "`?`";
}

/** The capabilities whose lifecycle includes a dispatch a caller can catch. On
 *  every other one a thrown error is a boot-time failure, not a structured
 *  runtime error for a downstream caller — a provider resolves configuration, a
 *  type has no instance, a sink is written to directly, and a service or mount
 *  is STARTED rather than called (what a router renders is not what a router
 *  throws).
 *
 *  The strict half of rule 8 in the built-in `Telo.Definition` / `Telo.Abstract` schemas, and it has
 *  to exist here for the reason every `x-telo-*` accessor has a strict half: the
 *  kernel refuses at `create()`, which is a boot failure on a manifest that
 *  passed `telo check` — the static/runtime disagreement this repository treats
 *  as a defect. The two must agree; a change to either belongs in both.
 *
 *  **Reported for a DEPENDENCY's definition too**, unlike `X_TELO_REF_UNRESOLVED`
 *  and `DEPRECATED_KIND`, which are entry-module-scoped. Those report something a
 *  consumer can live with — a slot that cannot be checked, a kind that still
 *  works — so silence costs them nothing and the noise is not theirs to fix.
 *  This one reports a definition the kernel REFUSES, so the manifest importing it
 *  cannot start at all: withholding that would replace a `telo check` error with
 *  an identical boot failure and no earlier warning. The action is a consumer's
 *  to take (pin another version, report upstream) even though the edit is not.
 *  Matches the neighbouring `INHERIT_WITHOUT_STEP_CONTEXT`, which is fatal the
 *  same way. The allowlist is the capability roster's `throwsAllowed` roles
 *  (`capability-roster.ts`), which the built-in `Telo.Definition` /
 *  `Telo.Abstract` schemas derive too, and the block's shape is theirs. */
const THROWS_CAPABLE = new Set(throwsAllowedCapabilities());
const DECLARABLE = new Set(declarableCapabilities());

/** The `throws:` property of the built-in `Telo.Abstract` schema — the one
 *  definition of an abstract's block, which the kernel validates it against. */
function abstractThrowsSchema(): Record<string, unknown> {
  const root = builtinDocumentSchema("Abstract") as {
    properties?: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  const throws = root.properties?.throws;
  if (!throws || typeof throws !== "object") {
    throw new Error("The built-in Telo.Abstract schema declares no `throws` property.");
  }
  // A code's `message` reaches the fragments hoisted into the document's root.
  return root.$defs ? { ...(throws as Record<string, unknown>), $defs: root.$defs } : (throws as Record<string, unknown>);
}

let abstractThrowsValidator: ValidateFunction | undefined;
/** The renderer anchors at the validated value; re-anchor its path at `/throws`. */
const atThrows = (message: string): string =>
  message.startsWith("/ ") ? `/throws ${message.slice(2)}` : message.startsWith("/") ? `/throws${message}` : `/throws ${message}`;
const validateAbstractThrows = (value: unknown) => {
  const validate = (abstractThrowsValidator ??= createAjv().compile(abstractThrowsSchema()));
  return validate(value) ? [] : schemaIssues(validate.errors, value);
};

function validateThrowsDeclarations(manifests: ResourceManifest[]): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const throws = (m as Record<string, any>).throws;
    if (!throws) continue;
    const name = (m.metadata?.name as string | undefined) ?? "<unnamed>";
    const filePath = (m.metadata as { source?: string } | undefined)?.source;

    if (m.kind === "Telo.Abstract") {
      const issues = validateAbstractThrows(throws);
      for (const issue of issues) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "SCHEMA_VIOLATION",
          source: SOURCE,
          message: `Telo.Abstract/${name}: ${atThrows(issue.message)}`,
          data: { resource: { kind: m.kind, name }, filePath, path: issue.path ? `throws.${issue.path}` : "throws" },
        });
      }
      if (issues.length > 0) continue;
    }

    // Only a DECLARED capability is judged; one inherited through `extends` is
    // resolved elsewhere. A value no author may declare is the roster's to report
    // (`CAPABILITY_UNKNOWN` / `CAPABILITY_NOT_DECLARABLE`) — the kernel refuses it
    // before it reads `throws:` at all.
    const capability = (m as Record<string, any>).capability as string | undefined;
    const dynamicKey = throws.inherit !== undefined ? "inherit" : throws.passthrough !== undefined ? "passthrough" : undefined;
    if (
      dynamicKey &&
      typeof capability === "string" &&
      DECLARABLE.has(capability) &&
      !THROWS_CAPABLE.has(capability)
    ) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "THROWS_ON_NON_DISPATCH_CAPABILITY",
        source: SOURCE,
        message:
          `${m.kind} '${name}' declares throws.${dynamicKey} but its capability is '${capability}'. ` +
          `A union derived from what a kind dispatches describes what a CALLER can catch, so it is ` +
          `only meaningful on ${throwsAllowedCapabilities().join(" or ")}; a '${capability}' kind may ` +
          `declare throws.codes — the failures it answers with — and nothing more. The kernel ` +
          `refuses this definition at create(), so a manifest carrying it cannot start.`,
        data: { resource: { kind: m.kind, name }, filePath, path: `throws.${dynamicKey}` },
      });
      continue;
    }
    if (throws.inherit === true) {
      const schema = (m as Record<string, any>).schema as Record<string, any> | undefined;
      if (!schemaDrivesInvocables(schema)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "INHERIT_WITHOUT_STEP_CONTEXT",
          source: SOURCE,
          message:
            `Telo.Definition '${name}' declares throws.inherit: true but its schema dispatches nothing ` +
            `a failure can come back through. inherit makes the kind's union the union of what it ` +
            `dispatches, so the schema needs a step body (an array field with ` +
            `'items: { $ref: "telo://manifest#/$defs/Step" }', or the legacy x-telo-step-context ` +
            `annotation) or a reference slot whose use includes 'call' or 'trigger.consumer' ` +
            `(for a use case map, in any case; a slot declaring no use counts as 'call'). ` +
            `'detached' and 'trigger.inbound' run where no caller awaits them, and ` +
            `'dependency' / 'schema' dispatch nothing.`,
          data: { resource: { kind: m.kind, name }, filePath, path: "throws.inherit" },
        });
      }
    }
  }
  return diagnostics;
}

/** Rule 8 extension: `inherit: true` needs something to inherit from — a step
 *  body, or a reference slot whose use (any case of a case map) hands a failure
 *  back. The schema-only mode of the walk the resolver runs per instance, so the
 *  check and the union reach the same slots. */
function schemaDrivesInvocables(schema: Record<string, any> | undefined): boolean {
  let drives = false;
  forEachDeclaredSlot(schema, (declared) => {
    if (
      declared.kind === "step" ||
      declared.slots.some((slot) => throwsUses(slot).some(handsFailureBack))
    ) {
      drives = true;
    }
  });
  return drives;
}

/** Entry point — invoked once per analyze() run. */
export function validateThrowsCoverage(
  manifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  env: CelEnvironment,
  aliasesByModule: Map<string, AliasResolver> = new Map(),
  rootModules: Set<string> = new Set(),
  /** Each imported library's full document set, so the walk can follow an
   *  exported entry point into the siblings it invokes — which a consumer's
   *  flat set does not carry. */
  moduleManifests: Map<string, ResourceManifest[]> = new Map(),
  /** The ladder the analysis already built over `manifests`, so the CEL scope
   *  rule and this pass read one. */
  built?: CatchLadder,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  diagnostics.push(...validateThrowsDeclarations(manifests));

  // Every catch list — a `with:`-scoped declaration's included, since standing
  // a server up around a test is exactly that shape — with the ladder each
  // dispatch site climbs. A scope list has to be known before any site it
  // covers is judged, so the ladder is built whole first.
  const ladder =
    built ??
    new CatchLadder(manifests, defs, aliases, env, aliasesByModule, rootModules, moduleManifests);

  for (const manifest of ladder.allManifests) {
    if (!manifest.kind || !manifest.metadata?.name) continue;
    if (isKindDocument(manifest)) continue;
    const definition = ladder.definitionOf(manifest);
    if (!definition?.schema) continue;
    // A scoped declaration is reported against the document it is WRITTEN in —
    // its owner's — at its own position inside that owner's scope array.
    const enclosing = ladder.scopedBy.get(manifest);
    const anchor = enclosing?.owner ?? manifest;
    const pathPrefix = enclosing ? `${enclosing.path}.` : "";
    const resource = { kind: manifest.kind, name: manifest.metadata.name as string };
    const routing = enclosing ? { kind: anchor.kind, name: anchor.metadata!.name as string } : resource;
    const filePath = (anchor.metadata as { source?: string } | undefined)?.source;
    collectOutcomeLists(
      manifest,
      definition.schema,
      (entries, arrayPath) => {
        diagnostics.push(
          ...checkCatchAllPlacement(entries, resource, "returns", filePath, `${pathPrefix}${arrayPath}`, routing),
        );
      },
      () => {},
    );
  }

  // Each list against its own denominator, and each dispatch site against
  // everything that can render its throws.
  for (const site of ladder.lists) {
    diagnostics.push(
      ...checkCatchAllPlacement(
        site.entries,
        site.resource,
        "catches",
        site.filePath,
        site.arrayPath,
        site.routing,
      ),
    );
    const union = ladder.unionOf(site);
    diagnostics.push(
      ...checkUndeclaredCodes(
        site.readings,
        union,
        site.filePath,
        site.arrayPath,
        site.isScope
          ? "the throw union of everything this resource drives"
          : "the handler's declared throw union",
        site.routing,
      ),
    );
    if (site.isScope) continue;
    diagnostics.push(...checkCoverage(site, union, ladder));
  }

  return diagnostics;
}
