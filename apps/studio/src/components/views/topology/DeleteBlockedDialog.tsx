import { ArrowRight } from "lucide-react";
import type { ResourceReference } from "../../../resource-references";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";

/**
 * Why a resource could not be deleted: the slots that still name it.
 *
 * Deleting it anyway is representable — the editor already clears every dangling
 * ref when a node is deleted from the canvas — but it is the wrong default here:
 * a provider or a type is referenced from resources that are nowhere on screen
 * (that is what makes them ambient), so a silent cascade would blank slots the
 * user never saw. Naming them and refusing puts the decision where the evidence
 * is, and each row leads to the resource that has to change.
 */
export function DeleteBlockedDialog({
  name,
  references,
  onOpenChange,
  onSelectResource,
}: {
  /** The resource the delete was refused for. Null closes the dialog. */
  name: string | null;
  /**
   * What still names it — EMPTY meaning the answer is not known rather than
   * that there is nothing, which is the case where the analysis has not
   * finished. The two read very differently and only one of them is a reason to
   * go and edit something, so the dialog says which it is instead of rendering
   * "0 places still name it".
   */
  references: ResourceReference[];
  onOpenChange: (open: boolean) => void;
  onSelectResource: (kind: string, name: string) => void;
}) {
  return (
    <Dialog open={!!name} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="font-mono">{name}</span>{" "}
            {references.length === 0 ? "cannot be checked yet" : "is still referenced"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {references.length === 0 ? (
            <>
              The analysis has not finished, so what still names it is unknown. Deleting now
              could leave references pointing at nothing — try again in a moment.
            </>
          ) : (
            <>
              {references.length === 1
                ? "One place still names it"
                : `${references.length} places still name it`}
              . Clear {references.length === 1 ? "it" : "them"} first — deleting now would leave{" "}
              {references.length === 1 ? "a reference" : "references"} pointing at nothing.
            </>
          )}
        </p>
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {references.map((ref) => (
            <li key={`${ref.via}/${ref.source.kind}/${ref.source.name}/${ref.path}`}>
              <button
                className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                onClick={() => {
                  onSelectResource(ref.source.kind, ref.source.name);
                  onOpenChange(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-800 dark:text-zinc-100">
                    {ref.source.name}
                  </span>
                  {/* The field, not just the resource: one resource may hold
                      several references to the same target, and "which field"
                      is what the user has to go and clear. */}
                  <span className="block truncate font-mono text-[10px] text-zinc-400">
                    {ref.path}
                  </span>
                </span>
                {/* An expression has to be rewritten by hand — saying so here
                    is what makes "clear them first" actionable rather than a
                    wall. */}
                {ref.via === "cel" && (
                  <span className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    expression
                  </span>
                )}
                <ArrowRight className="size-3.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
