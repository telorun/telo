import { CapabilityBadge } from "../shared/resource-badges";
import type { ViewProps } from "../types";
import { matches, OutlineHead, OutlineSection } from "./outline-table";

/** Every kind resolved in the module's closure — its own definitions plus
 *  everything its imports brought in. A reference read-out: creating a resource
 *  of a kind is offered where the kind arrives (an import's row on the graph's
 *  rail) and where a slot needs one (the reference picker), both filtered to
 *  what fits. */
export function KindTable({ viewData, query }: ViewProps & { query: string }) {
  const kinds = [...viewData.kinds.values()].filter((k) =>
    matches(query, k.fullKind, k.alias, k.kindName, k.capability),
  );

  return (
    <OutlineSection
      title="Kinds"
      count={kinds.length}
      filtered={query !== ""}
      emptyText="No kinds resolved"
    >
      <table className="w-full text-left text-sm">
        <OutlineHead columns={["Kind", "Alias", "Capability"]} />
        <tbody>
          {kinds.map((k) => (
            <tr
              key={k.fullKind}
              className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300"
            >
              <td className="py-1.5 pr-3 text-xs">{k.fullKind}</td>
              <td className="py-1.5 pr-3 text-xs">{k.alias}</td>
              <td className="py-1.5">
                {k.capability && <CapabilityBadge capability={k.capability} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </OutlineSection>
  );
}
