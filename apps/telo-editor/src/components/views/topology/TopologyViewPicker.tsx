import { Check, LayoutGrid } from "lucide-react";
import type { TopologyViewDescriptor } from "./topology-view";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

/** Picks among the views applicable to what is focused. Rendered only when
 *  there is a choice — a single-candidate focus shows no control, so the
 *  registry costs nothing where it changes nothing. */
export function TopologyViewPicker({
  views,
  activeId,
  onPick,
}: {
  views: TopologyViewDescriptor[];
  activeId: string;
  onPick: (id: string) => void;
}) {
  if (views.length < 2) return null;
  const active = views.find((v) => v.id === activeId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs shadow-sm">
          <LayoutGrid className="size-3.5" />
          {active?.label ?? "View"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {views.map((v) => (
          <DropdownMenuItem
            key={v.id}
            className="flex-col items-start gap-0.5 text-xs"
            onSelect={() => onPick(v.id)}
          >
            <span className="flex w-full items-center gap-1.5 font-medium">
              {v.label}
              {v.id === activeId && <Check className="ml-auto size-3.5" />}
            </span>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{v.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
