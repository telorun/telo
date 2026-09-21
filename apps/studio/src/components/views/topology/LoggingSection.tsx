import { isRecord } from "../../../lib/utils";
import type { ParsedResource, Selection } from "../../../model";
import { Chip, isSelected } from "./ModuleBarChip";
import { Section } from "./ModuleBarSection";

/**
 * The Application's `logging:` block, as one row. It opens the whole block in
 * the detail panel, typed by the module kind's real `logging` schema — the
 * shape the checker validates it by.
 */
export function LoggingSection({
  root,
  moduleSchema,
  selection,
  onSelect,
}: {
  root: ParsedResource;
  moduleSchema: Record<string, unknown> | undefined;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const moduleProperties = moduleSchema?.properties;
  const declaredLogging = isRecord(moduleProperties) ? moduleProperties.logging : undefined;
  const loggingSchema = isRecord(declaredLogging) ? declaredLogging : undefined;

  return (
    <Section title="Logging" addTitle="Configure logging">
      <Chip
        chip={{ name: "logging", detail: loggingSummary(root.fields.logging) }}
        active={isSelected(selection, root, "/logging")}
        openTitle="Threshold, redaction, sampling and sinks"
        onOpen={
          loggingSchema
            ? () =>
                onSelect({
                  resource: { kind: root.kind, name: root.name },
                  pointer: "/logging",
                  schema: loggingSchema,
                  // The whole block resolves once, at load.
                  celEval: "compile",
                })
            : undefined
        }
      />
    </Section>
  );
}

/** A one-line account of the `logging:` block, or that it is left at defaults. */
function loggingSummary(logging: unknown): string {
  if (!isRecord(logging)) return "defaults";
  const parts: string[] = [];
  if (typeof logging.level === "string") parts.push(`level ${logging.level}`);
  if (Array.isArray(logging.sinks)) {
    parts.push(`${logging.sinks.length} sink${logging.sinks.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "configured";
}
