import { TriangleAlert } from "lucide-react";

import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { outdatedTitle } from "../../sidebar/import-upgrade-notices";
import { useModuleVersions } from "../../sidebar/useModuleVersions";
import { useUpgradeTargets } from "../../sidebar/useUpgradeTargets";
import { useVersionCompatibility } from "../../sidebar/useVersionCompatibility";
import { Badge } from "../../ui/badge";
import type { ViewProps } from "../types";
import { matches, OutlineHead, OutlineSection } from "./outline-table";

/** What the module depends on, in full: the ref as written, how it resolves,
 *  and whether something newer is published.
 *
 *  Read-out only. Adding, removing and moving an import between versions are
 *  actions on the graph's declarations rail, which is where they are performed
 *  while looking at what depends on them. */
export function ImportTable({ viewData, hubUrl, manifestCacheUrl, onOpenModule, query }: ViewProps & { query: string }) {
  const diagState = useDiagnosticsState();
  const manifest = viewData.manifest;
  const filePaths = getModuleFiles(manifest);
  // The same lookups the rail drives, so this read-out and that surface's
  // upgrade offer are answers about the same versions.
  const listVersions = useModuleVersions(hubUrl);
  const isCompatible = useVersionCompatibility(manifestCacheUrl);
  const targets = useUpgradeTargets(manifest.imports, listVersions, isCompatible);
  const imports = manifest.imports.filter((imp) =>
    matches(query, imp.name, imp.source, imp.resolvedPath),
  );

  return (
    <OutlineSection
      title="Imports"
      count={imports.length}
      filtered={query !== ""}
      emptyText="No imports"
    >
      <table className="w-full text-left text-sm">
        <OutlineHead columns={[null, "Alias", "Source", "Type", "Resolved path"]} />
        <tbody>
          {imports.map((imp) => {
            const target = targets.get(imp.name);
            // "Behind" is about what is published; whether anything can be
            // offered is a separate question, and conflating them would hide a
            // newer version that exists.
            const outdated = target?.newest != null;
            const summary = summarizeResource(diagState, filePaths, imp.name);
            return (
              <tr
                key={imp.name}
                className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300"
              >
                <td className="w-5 py-1.5 text-center">
                  <DiagnosticBadge summary={summary} size="sm" showCount={false} />
                </td>
                <td className="py-1.5 pr-3 text-xs font-medium">{imp.name}</td>
                <td className="max-w-64 py-1.5 pr-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate" title={imp.source}>
                      {imp.source}
                    </span>
                    {outdated && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400"
                        title={outdatedTitle(target?.newest, target?.best?.version, target?.heldBack ?? null)}
                      >
                        Outdated
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="py-1.5 pr-3 text-xs">{imp.importKind}</td>
                <td className="max-w-64 py-1.5 pr-3 text-xs">
                  {imp.loadError ? (
                    // The workspace opened without this dependency. Saying so
                    // here is the whole point — a row that just resolved to
                    // nothing left the author guessing which import was missing.
                    <span
                      className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
                      title={imp.loadError}
                    >
                      <TriangleAlert className="size-3.5 shrink-0" />
                      <span className="truncate">Unresolved</span>
                    </span>
                  ) : imp.resolvedPath ? (
                    <button
                      type="button"
                      onClick={() => onOpenModule(imp.resolvedPath!)}
                      className="block max-w-full truncate text-left text-blue-600 hover:underline dark:text-blue-400"
                      title={`Open ${imp.resolvedPath}`}
                    >
                      {imp.resolvedPath}
                    </button>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </OutlineSection>
  );
}
