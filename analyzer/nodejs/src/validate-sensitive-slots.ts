import type { ResourceManifest } from "@telorun/sdk";
import {
  contractSites,
  inNamedShape,
  isExportedShape,
  type KindCapability,
  markedNodes,
  namedShapeResolver,
  unreachedMarkPlace,
  type WrittenAt,
} from "./contract-mark-reach.js";
import { sensitivePaths } from "./invocation-contract.js";

/**
 * `x-telo-sensitive` where nothing reads it.
 *
 * The annotation has exactly one consumer: the kernel resolves it from a
 * resource's bound CONTRACT — `inputType` / `outputType` — following `$ref` into
 * `$defs` entries and named shapes, and carries the marked value as
 * `[redacted]` in trace payloads. A mark no contract reaches is an unknown
 * keyword in an open schema, which is to say it validates, ships, and does
 * nothing.
 *
 * For a security control that is the worst available failure: an author marks a
 * token, sees no error, and puts it on the debug wire anyway. So an unreached
 * mark is reported rather than ignored — the same posture `X_TELO_REF_UNRESOLVED`
 * takes toward a reference constraint that resolves to nothing, and for the same
 * reason: silence reads as protection. Reachability is the kernel's own walk
 * (`sensitivePaths`) over every declared contract, so the two agree on which
 * marks are read. A mark in a named shape its library exports is left alone: an
 * importer's contract may reach it.
 *
 * Scoped by the caller to the entry's own modules, since a dependency's schema
 * is not the consumer's to fix.
 */
export interface SensitiveSlotIssue {
  code: "SENSITIVE_ANNOTATION_MISPLACED" | "SENSITIVE_ANNOTATION_INVALID";
  manifest: ResourceManifest;
  /** Dotted path to the annotated schema node. */
  path: string;
  message: string;
}

const ANNOTATION = "x-telo-sensitive";

export function validateSensitiveSlots(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  capabilityOf: KindCapability,
): SensitiveSlotIssue[] {
  const marks = markedNodes(manifests, ANNOTATION);
  if (marks.size === 0) return [];
  const issues: SensitiveSlotIssue[] = [];
  const own = (written: WrittenAt): boolean => {
    const owner = (written.manifest.metadata as { module?: string } | undefined)?.module;
    return owner === undefined || rootModules.has(owner);
  };

  const reached = new Set<object>();
  const resolveRef = namedShapeResolver(manifests);
  for (const site of contractSites(manifests)) sensitivePaths(site.schema, resolveRef, reached);

  for (const [node, written] of marks) {
    if (!own(written)) continue;
    const value = (node as Record<string, unknown>)[ANNOTATION];
    const path = written.path.join(".");
    if (value !== true) {
      issues.push({
        code: "SENSITIVE_ANNOTATION_INVALID",
        manifest: written.manifest,
        path,
        message:
          `'${ANNOTATION}' must be \`true\`; got ${JSON.stringify(value)}. ` +
          `It is a marker, not a level — a value other than \`true\` reads as "not sensitive".`,
      });
      continue;
    }
    if (reached.has(node)) continue;
    const shape = inNamedShape(written, capabilityOf);
    if (shape && isExportedShape(written.manifest, manifests)) continue;
    issues.push({
      code: "SENSITIVE_ANNOTATION_MISPLACED",
      manifest: written.manifest,
      path,
      message:
        `'${ANNOTATION}' is only read where a resource's declared contract ` +
        `(\`inputType\` / \`outputType\`) reaches it, following \`$ref\`, and this node is ` +
        `${unreachedMarkPlace(written, capabilityOf)}. The kernel will not redact it, so the value would still reach trace ` +
        `payloads and the debug wire. Move the mark onto the contract property ` +
        `that carries the value.`,
    });
  }
  return issues;
}
