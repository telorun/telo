import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import type { ScreenPoint } from "./graph-nodes";

/**
 * Filling a slot, as one menu at the gesture: what is already declared and fits,
 * then what could be created to fit.
 *
 * The `+` beside a socket and a drag let go in empty space used to open a
 * create-only dialog, so the commoner request — point at the resource I already
 * have — had no words in it, and an imported instance had none at all once it
 * stopped being a box to drop onto. Both gestures open this instead, and both
 * open it where they were made.
 *
 * **Anchored to a POINT, not to a control**, which is what lets one menu serve
 * both: a drag ends wherever the reader let go, and there is no element there to
 * hang a trigger on. So the trigger is an empty box fixed at that point — a
 * whole menu per gesture would otherwise mean one mounted per row on the canvas,
 * and a second implementation for the drop.
 *
 * Opened rather than openable: it exists only while a gesture is in flight, so a
 * trigger the reader has to click again would be a second click for the click
 * they just made. Dismissing it without choosing is a cancel.
 */
export interface WireMenuProps {
  /** Where it opens, in viewport coordinates — the menu is portalled to the
   *  document, so a canvas coordinate would drift with the pan and zoom it knows
   *  nothing about. */
  at: ScreenPoint;
  /** Names already declared that this site accepts, as a reference to each would
   *  be WRITTEN — alias-qualified where it crosses an import boundary. */
  candidates: string[];
  /** Kinds one could be created as, as the author would write them. */
  createKinds: string[];
  onPick: (reference: string) => void;
  onCreate: (kind: string) => void;
  onCancel: () => void;
}

export function WireMenu({
  at,
  candidates,
  createKinds,
  onPick,
  onCreate,
  onCancel,
}: WireMenuProps) {
  const empty = candidates.length === 0 && createKinds.length === 0;
  return (
    <DropdownMenu
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DropdownMenuTrigger
        aria-hidden
        tabIndex={-1}
        className="fixed size-0"
        style={{ left: at.x, top: at.y }}
      />
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {/* Said rather than shown as an empty list: a menu with nothing in it
            reads as a menu that failed to load. */}
        {empty && (
          <DropdownMenuLabel className="font-normal text-zinc-400">
            Nothing declared fits this slot, and no imported kind can fill it.
          </DropdownMenuLabel>
        )}
        {candidates.length > 0 && <DropdownMenuLabel>Link</DropdownMenuLabel>}
        {candidates.map((reference) => (
          <DropdownMenuItem key={reference} onSelect={() => onPick(reference)}>
            {reference}
          </DropdownMenuItem>
        ))}
        {candidates.length > 0 && createKinds.length > 0 && <DropdownMenuSeparator />}
        {createKinds.length > 0 && <DropdownMenuLabel>Create and link</DropdownMenuLabel>}
        {createKinds.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => onCreate(kind)}>
            New {kind}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
