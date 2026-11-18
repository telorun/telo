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
import { isNeedTypeDoc, readNeedTypeShape } from "./need-type.js";

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

/** The annotation this pass judges. */
export const SENSITIVE_ANNOTATION = "x-telo-sensitive";
const ANNOTATION = SENSITIVE_ANNOTATION;

export function validateSensitiveSlots(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  capabilityOf: KindCapability,
): SensitiveSlotIssue[] {
  const marks = markedNodes(manifests, ANNOTATION);
  if (marks.size === 0) return [];
  const reached = new Set<object>();
  const resolveRef = namedShapeResolver(manifests);
  for (const site of contractSites(manifests)) sensitivePaths(site.schema, resolveRef, reached);
  const needFields = sensitiveNeedFields(manifests);
  const issues: SensitiveSlotIssue[] = [];
  for (const [node, written] of marks) {
    const issue = sensitiveMarkIssue(node, written, reached.has(node), {
      rootModules,
      capabilityOf,
      needFields,
      exported: (manifest) => isExportedShape(manifest, manifests),
    });
    if (issue) issues.push(issue);
  }
  return issues;
}

/**
 * A need type's fields are the other place the mark is read: the kernel adds a
 * sensitive field's value to the redaction set of every module context the
 * fulfilment reaches. What the mark may be there — `true`, on a text field — is
 * the need table's refusal, which the kernel twins at load for every module.
 */
export function sensitiveNeedFields(manifests: readonly ResourceManifest[]): Set<object> {
  const needFields = new Set<object>();
  for (const manifest of manifests) {
    if (!isNeedTypeDoc(manifest)) continue;
    for (const schema of Object.values(readNeedTypeShape(manifest).fields)) {
      if (Object.hasOwn(schema, ANNOTATION)) needFields.add(schema);
    }
  }
  return needFields;
}

/** What one mark's verdict reads beside whether a contract reaches it. */
export interface SensitiveMarkContext {
  readonly rootModules: ReadonlySet<string>;
  readonly capabilityOf: KindCapability;
  readonly needFields: ReadonlySet<object>;
  /** Whether a named shape is exported by its library. */
  readonly exported: (manifest: ResourceManifest) => boolean;
}

/** The issue of the mark `node`, written at `written`, that a contract reaches
 *  or not (`reached`) — undefined where there is none. */
export function sensitiveMarkIssue(
  node: object,
  written: WrittenAt,
  reached: boolean,
  ctx: SensitiveMarkContext,
): SensitiveSlotIssue | undefined {
  const owner = (written.manifest.metadata as { module?: string } | undefined)?.module;
  if ((owner !== undefined && !ctx.rootModules.has(owner)) || ctx.needFields.has(node)) return undefined;
  const value = (node as Record<string, unknown>)[ANNOTATION];
  const path = written.path.join(".");
  if (value !== true) {
    return {
      code: "SENSITIVE_ANNOTATION_INVALID",
      manifest: written.manifest,
      path,
      message:
        `'${ANNOTATION}' must be \`true\`; got ${JSON.stringify(value)}. ` +
        `It is a marker, not a level — a value other than \`true\` reads as "not sensitive".`,
    };
  }
  if (reached) return undefined;
  if (inNamedShape(written, ctx.capabilityOf) && ctx.exported(written.manifest)) return undefined;
  return {
    code: "SENSITIVE_ANNOTATION_MISPLACED",
    manifest: written.manifest,
    path,
    message:
      `'${ANNOTATION}' is only read where a resource's declared contract ` +
      `(\`inputType\` / \`outputType\`) reaches it, following \`$ref\`, and this node is ` +
      `${unreachedMarkPlace(written, ctx.capabilityOf)}. The kernel will not redact it, so the value would still reach trace ` +
      `payloads and the debug wire. Move the mark onto the contract property ` +
      `that carries the value.`,
  };
}
