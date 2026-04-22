import type { AnalysisRegistry } from "@telorun/analyzer";
import type { CompletionResult } from "../types.js";
import { detectContext } from "./detect-context.js";
import { propKeyCompletions } from "./prop-keys.js";
import { CAPABILITY_VALUES } from "./valid-capabilities.js";

function kindCompletions(registry: AnalysisRegistry | undefined): CompletionResult[] {
  const kinds = new Set<string>(
    registry
      ? registry.validUserFacingKinds()
      : ["Telo.Application", "Telo.Library", "Telo.Import", "Telo.Definition"],
  );
  return Array.from(kinds).map((kind) => ({
    label: kind,
    kind: "class",
    detail: "Telo resource kind",
  }));
}

function capabilityCompletions(): CompletionResult[] {
  return CAPABILITY_VALUES.map((cap) => ({
    label: cap,
    kind: "enumMember",
    detail: "Telo capability",
  }));
}

export function buildCompletions(
  text: string,
  line: number,
  character: number,
  registry: AnalysisRegistry | undefined,
): CompletionResult[] {
  const ctx = detectContext(text, line, character);
  if (!ctx) return [];
  if (ctx.type === "kind") return kindCompletions(registry);
  if (ctx.type === "capability") return capabilityCompletions();
  return propKeyCompletions(ctx.docKind, ctx.yamlPath, ctx.existingKeys, registry);
}
