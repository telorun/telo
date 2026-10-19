import { TextSelect, X } from "lucide-react";
import { selectionLabel, type EditorSelection } from "@/agent";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspaceFileLink } from "./WorkspaceFileLink";

/**
 * An editor selection on a message: its file and lines, opening the file at
 * the first of them. On the composer it is what the next message carries, and
 * Remove leaves it out.
 */
export function SelectionChip({
  selection,
  onRemove,
  className,
}: {
  selection: EditorSelection;
  onRemove?: () => void;
  className?: string;
}) {
  const label = selectionLabel(selection);
  const lines = selection.endLine - selection.startLine + 1;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-1 text-xs",
        className,
      )}
      title={selection.text}
    >
      <TextSelect className="size-3.5 shrink-0 text-muted-foreground" />
      <WorkspaceFileLink path={selection.file} line={selection.startLine} className="truncate text-xs">
        {label}
      </WorkspaceFileLink>
      <span className="shrink-0 text-muted-foreground">
        {lines === 1 ? "1 line" : `${lines} lines`}
      </span>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={onRemove}
          aria-label={`Leave ${label} out of the message`}
          title="Leave out of the message"
        >
          <X />
        </Button>
      )}
    </div>
  );
}
