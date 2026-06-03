import { CapabilityBadge, TopologyBadge } from "../shared/resource-badges";
import type { ViewProps } from "../types";

/** Module-view tab listing every resource kind resolved in the module's
 *  closure (local definitions + imported kinds). */
export function KindsView({ viewData }: ViewProps) {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {viewData.kinds.size === 0 ? (
        <div className="flex h-full items-center justify-center">
          <span className="text-sm text-zinc-400 dark:text-zinc-600">No kinds resolved</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="pb-1.5 pr-3 font-medium">Kind</th>
                <th className="pb-1.5 pr-3 font-medium">Alias</th>
                <th className="pb-1.5 pr-3 font-medium">Capability</th>
                <th className="pb-1.5 font-medium">Topology</th>
              </tr>
            </thead>
            <tbody>
              {[...viewData.kinds.values()].map((k) => (
                <tr
                  key={k.fullKind}
                  className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300"
                >
                  <td className="py-1.5 pr-3 text-xs">{k.fullKind}</td>
                  <td className="py-1.5 pr-3 text-xs">{k.alias}</td>
                  <td className="py-1.5 pr-3">
                    {k.capability && <CapabilityBadge capability={k.capability} />}
                  </td>
                  <td className="py-1.5">
                    {k.topology && <TopologyBadge topology={k.topology} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
