import { sameSelection, useEditorSelection, type EditorSelection } from "@/agent";
import { SelectionChip } from "./SelectionChip";

/**
 * The selections the next message carries: those a queued message brought
 * back, then the live editor selection unless it is one of them. The only
 * reader of the live selection, so a drag re-renders these chips alone.
 */
export function ComposerSelections({
  carried,
  onRemoveCarried,
  onDropLive,
}: {
  carried: readonly EditorSelection[];
  onRemoveCarried: (index: number) => void;
  onDropLive: () => void;
}) {
  const live = useEditorSelection();
  const showLive = live !== null && !carried.some((s) => sameSelection(s, live));
  if (carried.length === 0 && !showLive) return null;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {carried.map((selection, i) => (
        <SelectionChip key={i} selection={selection} onRemove={() => onRemoveCarried(i)} />
      ))}
      {showLive && <SelectionChip selection={live} onRemove={onDropLive} />}
    </div>
  );
}
