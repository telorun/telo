import { checkName } from "@telorun/analyzer";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { nameViolationMessage } from "./name-violation-message";

interface ExtractInlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The inline resource's kind — what the extracted document declares. */
  kind: string;
  /** Prefilled name, derived from the kind the way a new resource's is. */
  suggestion: string;
  /** Names already declared in the module, which the new one may not collide
   *  with — a duplicate would make both unreachable by reference. */
  taken: string[];
  onExtract: (name: string) => void;
}

/**
 * Names the resource an inline declaration becomes.
 *
 * Asked rather than generated, because studio has no way to rename a resource
 * afterwards: a generated `crudResource2` would be permanent. The name is
 * checked with the analyzer's own rule, so a name this dialog accepts is one
 * `telo check` accepts — a second spelling of that rule here would drift.
 */
export function ExtractInlineDialog({
  open,
  onOpenChange,
  kind,
  suggestion,
  taken,
  onExtract,
}: ExtractInlineDialogProps) {
  const [name, setName] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(suggestion);
    setError(null);
  }, [open, suggestion]);

  function submit() {
    const trimmed = name.trim();
    const violation = checkName(trimmed, "value", "resource");
    if (violation) {
      setError(nameViolationMessage(violation, "value"));
      return;
    }
    if (taken.includes(trimmed)) {
      setError(`'${trimmed}' is already declared in this module.`);
      return;
    }
    onExtract(trimmed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extract {kind} to a resource</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            The declaration moves to its own document and the slot becomes a reference to it.
          </p>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {error && <span className="text-xs text-red-500">{error}</span>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Extract</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
