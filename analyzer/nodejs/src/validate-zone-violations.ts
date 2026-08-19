/**
 * `ZONE_ATTRIBUTE_VIOLATED` — a resource inside a region whose guarantee it
 * declares it cannot honour.
 *
 * The third leg of the zone-attribute mechanism, and the one that makes the
 * other two enforceable. `x-telo-provides-zone` says what a region guarantees
 * about its contents and `x-telo-requires-zone` says what a resource needs of
 * the region around it — but neither says *this resource breaks that
 * guarantee*, so until now an attribute could be declared, resolved and read
 * with nothing able to report the one thing it exists to prevent.
 *
 * **Generic over the whole vocabulary, and it names no kind.** The rule is one
 * sentence — *a region declaring attribute A must not contain a resource
 * declaring it violates A* — and it is run once per attribute in
 * `sdk/zone-attributes/`. So `noSuspend` (a parking kind inside a lease) and any
 * attribute added later are covered by the same traversal, and `modules/durable`
 * stays outside the analyzer's surface exactly as the topology-driven constraint
 * requires.
 *
 * **Both sentences are their authors' own.** The diagnostic prints the region's
 * declared reason and the violating kind's declared reason side by side, because
 * the useful message is the collision between two written claims — "this
 * transaction holds a connection a parked run would lose" against "this waits
 * for a delivery that may be days away" — and neither half is anything the
 * analyzer could generate.
 *
 * **Enforced at runtime, warned early**, like every other containment rule: the
 * walk under-approximates (an edge the call graph cannot see is invisible here),
 * and the runtime check in the violating controller is the real enforcement. It
 * is an ERROR rather than a warning nonetheless: where the walk *can* see the
 * path, the placement is decidably wrong — the region's promise and the
 * resource's rebuttal are both declarations, so nothing about the runtime can
 * reconcile them.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  SUSPENDING_BACKOFF_MS,
  ZONE_ATTRIBUTES,
  retryBackoffMs,
  type ResourceManifest,
} from "@telorun/sdk";
import type { CallGraph } from "./call-graph.js";
import { findZoneRegions, type DefinitionLookup } from "./resolve-zone-containment.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { readViolatesZone } from "./zone-slot.js";

const SOURCE = "telo";

export interface ZoneViolationArgs {
  graph: CallGraph;
  resolveDef: DefinitionLookup;
  /** Only report against modules the entry owns — a published dependency's
   *  placement is not the consumer's to fix. */
  reportModules: ReadonlySet<string>;
}

export function validateZoneViolations(args: ZoneViolationArgs): AnalysisDiagnostic[] {
  const { graph, resolveDef, reportModules } = args;
  const diagnostics: AnalysisDiagnostic[] = [];
  const reported = new Set<string>();

  // What each kind in the graph declares it cannot honour, resolved once. A
  // graph holds many instances of few kinds, and this is a schema read.
  const violationsOf = new Map<string, Record<string, string>>();
  const violations = (kind: string, module?: string): Record<string, string> => {
    const key = `${module ?? ""}\0${kind}`;
    let found = violationsOf.get(key);
    if (!found) {
      const def = resolveDef(kind, module);
      found = readViolatesZone(def?.schema as Record<string, any> | undefined);
      violationsOf.set(key, found);
    }
    return found;
  };

  for (const attribute of ZONE_ATTRIBUTES.keys()) {
    for (const region of findZoneRegions(graph, resolveDef, attribute)) {
      for (const contained of region.contents.values()) {
        // The one step-level rule, and it is separate because it is a property
        // of the STEP rather than of its target: a retry whose backoff is long
        // enough to park suspends the run from inside a region that promised
        // nothing in it would. Only `noSuspend` has such a rule, because only
        // `noSuspend` is broken by waiting.
        if (attribute === "noSuspend" && contained.node.type === "step") {
          const ownerNode = graph.nodes.get(contained.node.owner);
          const owner = ownerNode?.type === "resource" ? ownerNode : undefined;
          if (
            owner &&
            owned(owner.manifest, reportModules) &&
            suspendingBackoff(contained.node.step.retry)
          ) {
            const dedupe = `retry\0${contained.node.id}`;
            if (!reported.has(dedupe)) {
              reported.add(dedupe);
              diagnostics.push({
                severity: DiagnosticSeverity.Error,
                code: "ZONE_ATTRIBUTE_VIOLATED",
                source: SOURCE,
                message:
                  `Step '${contained.node.name ?? contained.node.path}' declares a retry ` +
                  `whose last backoff reaches ${SUSPENDING_BACKOFF_MS}ms, at which point a ` +
                  `re-attempt waits by PARKING the run rather than by sleeping — but it is ` +
                  `inside a ${region.provider.kind} ` +
                  `'${region.provider.name}' region that declares 'noSuspend' ` +
                  `(${region.reason}). Shorten the backoff, or move the retry outside the ` +
                  `region so it re-attempts the region as a whole.`,
                data: {
                  resource: { kind: owner.kind, name: owner.name },
                  filePath: (owner.manifest.metadata as { source?: string } | undefined)?.source,
                  path: contained.node.path,
                },
              });
            }
          }
        }
        // A step node is a dispatch site, not a resource — whatever it reaches
        // is in `contents` in its own right, so judging the step too would
        // report one placement twice.
        if (contained.node.type !== "resource") continue;
        const manifest = contained.node.manifest;
        const module = (manifest.metadata as { module?: string } | undefined)?.module;
        const rebuttal = violations(contained.node.kind, module)[attribute];
        if (!rebuttal) continue;
        if (!owned(manifest, reportModules)) continue;

        const dedupe = `${region.provider.id}\0${region.slot}\0${contained.node.id}\0${attribute}`;
        if (reported.has(dedupe)) continue;
        reported.add(dedupe);

        const path = [`${region.provider.name}.${region.slot}`, ...contained.via].join(" → ");
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "ZONE_ATTRIBUTE_VIOLATED",
          source: SOURCE,
          message:
            `${contained.node.kind} '${contained.node.name}' is inside a ` +
            `${region.provider.kind} '${region.provider.name}' region that declares ` +
            `'${attribute}' (${region.reason}), but ${contained.node.kind} cannot honour ` +
            `it: ${rebuttal}. Reached by ${path}. Move it outside the region, or use a ` +
            `region that does not make that promise.`,
          data: {
            resource: { kind: contained.node.kind, name: contained.node.name },
            filePath: (manifest.metadata as { source?: string } | undefined)?.source,
          },
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Does this declared retry policy back off far enough to park?
 *
 * EXACT, not an estimate, and it is the runtime's own arithmetic
 * (`retryBackoffMs`) rather than a second copy of it — a static rule that
 * re-derives what it describes drifts from the behaviour the first time either
 * side gains a knob. It is exact for a second reason too: the runtime branches
 * on the UN-JITTERED backoff, so there is no coin flip for this to
 * approximate. The last attempt has the largest backoff, so it decides.
 *
 * Only a STATICALLY KNOWN policy is judged — the `LIVE_VALUE_RETRIED` posture,
 * and for its reason: a CEL budget says nothing, and guessing would report a
 * conflict against a manifest that may never wait that long. An unreadable
 * policy is left to the runtime check, which sees the real number.
 */
function suspendingBackoff(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const policy = raw as Record<string, unknown>;
  if (!Object.values(policy).every(isStaticValue)) return false;
  const attempts = policy.attempts;
  if (typeof attempts !== "number" || attempts <= 0) return false;
  return retryBackoffMs(policy as never, attempts - 1) >= SUSPENDING_BACKOFF_MS;
}

/** A CEL leaf reaches here as a compiled value or a tagged sentinel, and either
 *  way the policy is not statically known. Refusing the whole policy rather than
 *  the one field is the conservative direction: `maxDelay` alone decides the
 *  answer, so reading around an unresolved one would report a bound the manifest
 *  may never reach. */
function isStaticValue(value: unknown): boolean {
  return value === undefined || typeof value === "number" || typeof value === "string";
}

function owned(manifest: ResourceManifest, reportModules: ReadonlySet<string>): boolean {
  const module = (manifest.metadata as { module?: string } | undefined)?.module;
  return !module || reportModules.size === 0 || reportModules.has(module);
}
