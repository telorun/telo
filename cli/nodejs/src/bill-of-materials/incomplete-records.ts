/**
 * `SBOM_INCOMPLETE`: a module in the closure with no complete record, reported
 * where its author can act — a local module at its own document, an artifact at
 * the import a local module wrote to reach it, naming the chain and the remedy
 * for that depth. An error unless the caller goes on past it, a warning then.
 */

import { DiagnosticSeverity, type AnalysisDiagnostic } from "@telorun/analyzer";
import { describeUnattributed } from "../bundle/module-bill-of-materials.js";
import type { ClosureModule } from "./module-closure.js";

export const SBOM_INCOMPLETE = "SBOM_INCOMPLETE";

const DEFINITION =
  "SBOM: the list of third-party components it ships, which vulnerability scanners read";

/** `Http (oci://…)`, or `Billing (oci://…) imports HttpServer (oci://…)` for a chain. */
export function namedAlong(node: ClosureModule): string {
  if (node.local || node.chain.length === 0) return `${node.subject.name} (${node.ref})`;
  const [first, ...rest] = node.chain;
  return [
    `${first!.alias} (${first!.source})`,
    ...rest.map((link, i) => `${i === 0 ? " imports " : ", which imports "}${link.module} (${link.source})`),
  ].join("");
}

/** What is missing, for the module the sentence names last. */
function missing(node: ClosureModule, defined: boolean): string {
  const sbom = defined ? `(${DEFINITION})` : "(SBOM)";
  const reason = node.unrecorded!;
  switch (reason.kind) {
    case "unpublished-record":
      return `was published without a software bill of materials ${sbom}`;
    case "incomplete":
      return node.local
        ? `has an incomplete software bill of materials ${sbom}: ${reason.layers.join(", ")} ` +
            `hold${reason.layers.length === 1 ? "s" : ""} code no producer reported`
        : `was published with an incomplete software bill of materials ${sbom}: ` +
            `${reason.layers.join(", ")} hold${reason.layers.length === 1 ? "s" : ""} code no producer reported`;
    case "packaged-without-record":
      return `is carried by the packaged executable without a software bill of materials ${sbom}`;
  }
}

function remedy(node: ClosureModule): string {
  const reason = node.unrecorded!;
  if (node.local) {
    if (reason.kind === "packaged-without-record") {
      return "Package it again with a telo that records it, or pass --allow-incomplete to write the document with this module marked incomplete.";
    }
    return (
      "Give each such file a package — a dependency declaring a name and a version, or a sources: entry " +
      "with a purl staging it — or pass --allow-incomplete to write the document with this module marked incomplete."
    );
  }
  if (node.chain.length <= 1) {
    return reason.kind === "unpublished-record"
      ? "Import a version published with one (`telo upgrade`), or pass --allow-incomplete to write the document with this module marked incomplete."
      : "Import a version published with a complete one (`telo upgrade`), ask its publisher to republish, or pass --allow-incomplete to write the document with this module marked incomplete.";
  }
  const head = node.chain[0]!;
  return (
    `Upgrade ${head.alias} to a version pinning a recorded ${node.subject.name}, ask its publisher to republish, ` +
    `or pass --allow-incomplete.`
  );
}

/** The unattributed inputs of a module derived here, one line each. */
function details(node: ClosureModule): string[] {
  const reason = node.unrecorded!;
  return reason.kind === "incomplete" ? describeUnattributed(reason.unattributed) : [];
}

/** One `SBOM_INCOMPLETE` for a module with no complete record. */
export function incompleteRecordDiagnostic(node: ClosureModule, allowIncomplete: boolean): AnalysisDiagnostic {
  const subject = namedAlong(node);
  const joiner = node.local || node.chain.length <= 1 ? " " : ", which ";
  const message = allowIncomplete
    ? `${subject}${joiner}${missing(node, false)}; it is marked incomplete and its contents are not listed.`
    : node.local || node.chain.length <= 1
      ? `${subject}${joiner}${missing(node, true)}, so what it ships cannot be listed. ${remedy(node)}`
      : `${subject}${joiner}${missing(node, true)}. ${remedy(node)}`;
  const lines = details(node);
  return {
    severity: allowIncomplete ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    code: SBOM_INCOMPLETE,
    source: "telo-sbom",
    message: lines.length > 0 ? `${message}\n${lines.map((line) => `  ${line}`).join("\n")}` : message,
    data: node.anchor.data,
  };
}
