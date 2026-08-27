import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import type { ViewProps } from "../types";
import { matches, OutlineHead, OutlineSection } from "./outline-table";

/** The kinds this module DECLARES — its `Telo.Definition` and `Telo.Abstract`
 *  documents. Listed here because they are not nodes on the graph canvas: for a
 *  Library they are its entire content, and without this block they would be
 *  reachable only through the raw source. */
export function DefinitionTable({
  viewData,
  selectedResource,
  onSelectResource,
  query,
}: ViewProps & { query: string }) {
  const diagState = useDiagnosticsState();
  const filePaths = getModuleFiles(viewData.manifest);
  const definitions = viewData.manifest.resources.filter(
    (r) =>
      (r.kind === "Telo.Definition" || r.kind === "Telo.Abstract") && matches(query, r.name, r.kind),
  );

  return (
    <OutlineSection
      title="Definitions"
      count={definitions.length}
      filtered={query !== ""}
      emptyText="No definitions"
    >
      <table className="w-full text-left text-sm">
        <OutlineHead columns={[null, "Name", "Declares"]} />
        <tbody>
          {definitions.map((r) => {
            const isSelected =
              selectedResource?.kind === r.kind && selectedResource?.name === r.name;
            const summary = summarizeResource(diagState, filePaths, r.name);
            return (
              <tr
                key={r.name}
                className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 ${
                  isSelected
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900/50"
                }`}
                onClick={() => onSelectResource(r.kind, r.name)}
              >
                <td className="w-5 py-1.5 text-center">
                  <DiagnosticBadge summary={summary} size="sm" showCount={false} />
                </td>
                <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                <td className="py-1.5 pr-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {r.kind === "Telo.Abstract" ? "abstract kind" : "kind"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </OutlineSection>
  );
}
