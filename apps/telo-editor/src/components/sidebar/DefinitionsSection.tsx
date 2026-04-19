import type { ParsedManifest } from "../../model";
import { getModuleFiles, summarizeResource } from "../../diagnostics-aggregate";
import { DiagnosticBadge } from "../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../diagnostics/DiagnosticsContext";
import { EmptyHint, SectionHeader, rowBase, rowHover } from "./primitives";

interface DefinitionsSectionProps {
  activeManifest: ParsedManifest | null;
  selectedResource: { kind: string; name: string } | null;
  onSelectResource: (kind: string, name: string) => void;
}

export function DefinitionsSection({
  activeManifest,
  selectedResource,
  onSelectResource,
}: DefinitionsSectionProps) {
  const definitions = activeManifest?.resources.filter((r) => r.kind === "Telo.Definition") ?? [];
  const diagState = useDiagnosticsState();
  const filePaths = activeManifest ? getModuleFiles(activeManifest) : [];

  return (
    <div className="pb-1 pt-2">
      <SectionHeader label="Definitions" />
      {definitions.length === 0 && <EmptyHint text="No definitions" />}
      {definitions.map((r) => {
        const isSelected = selectedResource?.name === r.name;
        const stateCls = isSelected
          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
          : `text-zinc-600 dark:text-zinc-400 ${rowHover}`;
        const summary = summarizeResource(diagState, filePaths, r.name);
        return (
          <div
            key={r.name}
            className={`${rowBase} ${stateCls}`}
            onClick={() => onSelectResource(r.kind, r.name)}
          >
            <span className="min-w-0 truncate">{r.name}</span>
            <DiagnosticBadge summary={summary} size="sm" />
          </div>
        );
      })}
    </div>
  );
}
