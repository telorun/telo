import type { ResourceManifest } from "@telorun/sdk";
import {
  type ContractSite,
  contractSites,
  inNamedShape,
  isExportedShape,
  type KindCapability,
  markedNodes,
  namedShapeResolver,
  unreachedMarkPlace,
  writtenNodeIndex,
  type WrittenAt,
} from "./contract-mark-reach.js";
import { resolveRefIn } from "./schema-compat.js";
import {
  spanAttributeNameProblem,
  spanAttributeNodeProblem,
  spanAttributePaths,
  X_TELO_SPAN_ATTRIBUTE,
} from "./span-attribute.js";

/**
 * `x-telo-span-attribute` checked by the walk the kernel runs.
 *
 * The kernel reads the annotation off each resource's bound contract, following
 * `$ref` into `$defs` entries and named shapes, and refuses a contract whose
 * marks break a rule at first dispatch (`ERR_SPAN_ATTRIBUTE_INVALID`). Here the
 * same walk (`spanAttributePaths`) runs over every declared contract, resolved
 * as the kernel resolves it, so the two find the same problems:
 *
 * - `SPAN_ATTRIBUTE_INVALID` — the value is not an attribute name, or names one
 *   the runtime sets itself; at the mark;
 * - `SPAN_ATTRIBUTE_MISPLACED` — the marked node is not scalar or sits beside
 *   `x-telo-sensitive: true` (at the mark); the contract reaches the mark at its
 *   root or through an array item or a map value (at the property that does,
 *   once per contract); or no contract reaches the mark at all — a kind's
 *   `schema:` / `status:`, a `$defs` entry nothing references, a named shape no
 *   contract uses and its library does not export — where it is inert.
 *
 * A mark in an exported named shape that nothing here reaches is judged by
 * itself alone: an importer's contract decides how it is reached.
 *
 * Reported for the entry's own modules only, like every schema issue.
 */
export interface SpanAttributeIssue {
  code: "SPAN_ATTRIBUTE_INVALID" | "SPAN_ATTRIBUTE_MISPLACED";
  manifest: ResourceManifest;
  /** Dotted path to the schema node the issue is reported at. */
  path: string;
  message: string;
}

export function validateSpanAttributes(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  capabilityOf: KindCapability,
): SpanAttributeIssue[] {
  const marks = markedNodes(manifests, X_TELO_SPAN_ATTRIBUTE);
  if (marks.size === 0) return [];
  const resolveRef = namedShapeResolver(manifests);
  const issues = new Map<string, SpanAttributeIssue>();
  let index: Map<object, WrittenAt> | undefined;
  const locate = (node: object): WrittenAt | undefined =>
    marks.get(node) ?? (index ??= writtenNodeIndex(manifests)).get(node);
  const report = spanIssueReporter(rootModules, (issue) => {
    const key = spanIssueKey(issue);
    if (!issues.has(key)) issues.set(key, issue);
  });
  const reached = new Set<object>();
  for (const site of contractSites(manifests)) {
    for (const node of spanContractIssues(site, resolveRef, locate, report)) reached.add(node);
  }
  for (const [node, written] of marks) {
    if (reached.has(node)) continue;
    spanMarkIssues(node, written, capabilityOf, (manifest) => isExportedShape(manifest, manifests), resolveRef, report);
  }
  return [...issues.values()];
}

/** How a span-attribute issue is reported at a place: `found` receives it,
 *  for the entry's own modules only. */
export type SpanIssueReport = (code: SpanAttributeIssue["code"], at: WrittenAt, message: string) => void;

export function spanIssueReporter(
  rootModules: ReadonlySet<string>,
  found: (issue: SpanAttributeIssue) => void,
): SpanIssueReport {
  return (code, at, message) => {
    const owner = (at.manifest.metadata as { module?: string } | undefined)?.module;
    if (owner !== undefined && !rootModules.has(owner)) return;
    found({ code, manifest: at.manifest, path: at.path.join("."), message: `${message}.` });
  };
}

/** What tells one issue from another: one place reports each once. */
export function spanIssueKey(issue: Pick<SpanAttributeIssue, "code" | "manifest" | "path" | "message">): string {
  return [issue.code, issue.manifest.kind, issue.manifest.metadata?.name, issue.path, issue.message].join("\0");
}

/** The kernel's walk over one declared contract: the issues it finds, each at
 *  the node `locate` places, and every marked node it reaches. */
export function spanContractIssues(
  site: ContractSite,
  resolveRef: (ref: string) => Record<string, any> | undefined,
  locate: (node: object) => WrittenAt | undefined,
  report: SpanIssueReport,
): Iterable<object> {
  const reading = spanAttributePaths(site.schema, resolveRef);
  for (const problem of reading.problems) {
    const at = problem.at === "reach" && problem.path.length === 0 ? site : (locate(problem.node) ?? site);
    report(problem.code, at, problem.message);
  }
  return reading.reached;
}

/** The issues of a mark no contract reaches: its name, and — in a named shape
 *  its library exports, which an importer's contract may reach — its node,
 *  else that nothing reads it. */
export function spanMarkIssues(
  node: object,
  written: WrittenAt,
  capabilityOf: KindCapability,
  exported: (manifest: ResourceManifest) => boolean,
  resolveRef: (ref: string) => Record<string, any> | undefined,
  report: SpanIssueReport,
): void {
  const mark = node as Record<string, any>;
  const nameProblem = spanAttributeNameProblem(mark[X_TELO_SPAN_ATTRIBUTE]);
  if (nameProblem) report("SPAN_ATTRIBUTE_INVALID", written, nameProblem);
  if (inNamedShape(written, capabilityOf) && exported(written.manifest)) {
    const root = (written.manifest as { schema?: Record<string, any> }).schema ?? mark;
    const resolved = resolveRefIn(mark, root, resolveRef).schema;
    const nodeProblem = spanAttributeNodeProblem(resolved === mark ? mark : { ...resolved, ...mark });
    if (nodeProblem) report("SPAN_ATTRIBUTE_MISPLACED", written, nodeProblem);
    return;
  }
  report("SPAN_ATTRIBUTE_MISPLACED", written, unreachedProblem(written, capabilityOf));
}

function unreachedProblem(written: WrittenAt, capabilityOf: KindCapability): string {
  return (
    `'${X_TELO_SPAN_ATTRIBUTE}' is read only where a resource's contract (\`inputType\` / ` +
    `\`outputType\`) reaches it through \`properties\`, following \`$ref\`, and this node is ` +
    `${unreachedMarkPlace(written, capabilityOf)}, so no span would ever carry it. Move the mark ` +
    `onto the contract property that carries the value`
  );
}
