import type { ViewModelConfigurations } from "@telorun/editor-protocol";
import { SlidersHorizontal } from "lucide-react";
import { optionOf, withPick } from "./configuration-picker-model";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";

/**
 * Picks the configuration the module graph is drawn in: one select per
 * dimension the module's choices read, each starting at its default. Changing
 * one redraws the graph — a choice's box changes its kind, never its identity.
 */
export function ConfigurationPicker({
  configurations,
  onPick,
}: {
  configurations: ViewModelConfigurations;
  onPick: (selected: Record<string, unknown>) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-3 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950"
      role="group"
      aria-label="Configuration the graph is drawn in"
    >
      <SlidersHorizontal className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
      {configurations.dimensions.map((dimension) => {
        const current = optionOf(configurations.selected[dimension.key]).id;
        return (
          <label key={dimension.key} className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            <span className="font-mono">{dimension.key}</span>
            <Select
              value={current}
              onValueChange={(id) => onPick(withPick(configurations.selected, dimension, id))}
            >
              <SelectTrigger size="sm" className="h-6 text-xs" aria-label={dimension.key}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dimension.values.map((value) => {
                  const option = optionOf(value);
                  return (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                      {JSON.stringify(value) === JSON.stringify(dimension.default) ? " (default)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </label>
        );
      })}
    </div>
  );
}
