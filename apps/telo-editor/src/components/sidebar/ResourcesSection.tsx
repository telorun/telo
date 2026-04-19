import type { ModuleViewData, ParsedManifest } from "../../model";
import { getModuleFiles, summarizeResource } from "../../diagnostics-aggregate";
import { DiagnosticBadge } from "../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../diagnostics/DiagnosticsContext";
import { EmptyHint, SectionHeader, rowBase, rowHover } from "./primitives";

interface ResourcesSectionProps {
  activeManifest: ParsedManifest | null;
  viewData: ModuleViewData | null;
  selectedResource: { kind: string; name: string } | null;
  graphContext: { kind: string; name: string } | null;
  onNavigateResource: (kind: string, name: string) => void;
  onCreateResource: () => void;
}

export function ResourcesSection({
  activeManifest,
  viewData,
  selectedResource,
  graphContext,
  onNavigateResource,
  onCreateResource,
}: ResourcesSectionProps) {
  const userResources = activeManifest?.resources.filter((r) => !r.kind.startsWith("Telo.")) ?? [];
  const kindsByFullKind = viewData?.kinds ?? new Map();
  const diagState = useDiagnosticsState();
  const filePaths = activeManifest ? getModuleFiles(activeManifest) : [];

  return (
    <div className="pb-1 pt-2">
      <SectionHeader label="Resources" onAdd={activeManifest ? onCreateResource : undefined} />
      {userResources.length === 0 && <EmptyHint text="No resources" />}
      {userResources.map((r) => {
        const kind = kindsByFullKind.get(r.kind);
        const isSelected =
          selectedResource?.kind === r.kind && selectedResource?.name === r.name;
        const isGraphContext =
          graphContext?.kind === r.kind && graphContext?.name === r.name;
        const stateCls = isSelected
          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
          : isGraphContext
            ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            : `text-zinc-600 dark:text-zinc-400 ${rowHover}`;
        const summary = summarizeResource(diagState, filePaths, r.name);
        return (
          <div
            key={`${r.kind}/${r.name}`}
            className={`${rowBase} ${stateCls} cursor-pointer`}
            onClick={() => onNavigateResource(r.kind, r.name)}
          >
            <span className="min-w-0 truncate">
              <span className="text-zinc-400 dark:text-zinc-500">{r.kind.split(".")[0]}.</span>
              {r.name}
            </span>
            <DiagnosticBadge summary={summary} size="sm" />
            {kind?.topology && (
              <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
                {kind.topology}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
