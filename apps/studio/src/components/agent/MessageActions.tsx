import type { ReactNode } from "react";
import { Copy, GitBranch, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What a message offers on hover beyond Copy. An absent handler is an action
 *  this agent does not serve, and is not shown. */
export interface MessageActionHandlers {
  /** A turn of the conversation is running: every action but Copy waits. */
  busy: boolean;
  /** User message: remove its turn and every later one, then send the edit. */
  onEditResend?: (text: string) => void;
  /** User message: remove its turn and every later one. */
  onDeleteFrom?: () => void;
  /** Assistant message: remove its turn and every later one, then send its
   *  request again. */
  onRetry?: () => void;
  /** Assistant message: a new conversation of every turn through this one. */
  onBranch?: () => void;
}

function Action({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function MessageActions({
  busy,
  copyText,
  onEdit,
  onDeleteFrom,
  onRetry,
  onBranch,
  className,
}: MessageActionHandlers & { copyText: string; onEdit?: () => void; className?: string }) {
  const copy = () => {
    navigator.clipboard.writeText(copyText).then(
      () => toast.success("Copied"),
      (err: unknown) => toast.error(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100",
          className,
        )}
      >
        <Action label="Copy" onClick={copy}>
          <Copy className="size-3.5" />
        </Action>
        {onEdit && (
          <Action label="Edit & resend" disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Action>
        )}
        {onDeleteFrom && (
          <Action label="Delete from here" disabled={busy} onClick={onDeleteFrom}>
            <Trash2 className="size-3.5" />
          </Action>
        )}
        {onRetry && (
          <Action label="Retry" disabled={busy} onClick={onRetry}>
            <RotateCcw className="size-3.5" />
          </Action>
        )}
        {onBranch && (
          <Action label="Branch" disabled={busy} onClick={onBranch}>
            <GitBranch className="size-3.5" />
          </Action>
        )}
      </div>
    </TooltipProvider>
  );
}
