import { useEffect, useState, type ReactNode } from "react";
import { turnsFrom, useAgent } from "@/agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type TurnAction =
  | { kind: "delete"; turnId: string }
  | { kind: "retry"; turnId: string; text: string }
  | { kind: "edit"; turnId: string; text: string };

function turns(n: number): string {
  return n === 1 ? "1 turn" : `${n} turns`;
}

/**
 * Retry, Edit & resend and Delete from here, with their confirmations. Delete
 * from here always asks, naming how many turns go; Retry and Edit & resend ask
 * only when turns after the one they replace would go too. A conversation that
 * moved on meanwhile is re-read, and the question asked again against it.
 */
export function useTurnActions(): {
  deleteFrom: (turnId: string) => void;
  retry: (turnId: string, text: string) => void;
  editResend: (turnId: string, text: string) => void;
  dialog: ReactNode;
} {
  const agent = useAgent();
  const [pending, setPending] = useState<TurnAction | null>(null);
  // An action whose conversation moved on: asked again once the re-read
  // transcript has rendered, by the same rule as the first time.
  const [reask, setReask] = useState<TurnAction | null>(null);

  const run = async (action: TurnAction) => {
    const outcome =
      action.kind === "delete"
        ? await agent.truncateFrom(action.turnId)
        : await agent.resendFrom(action.turnId, action.text);
    if (outcome === "changed") setReask(action);
  };

  // Delete from here always asks; Retry and Edit & resend only when later turns
  // go — or when their turn is gone, which the dialog then says.
  const request = (action: TurnAction) => {
    if (action.kind === "delete" || turnsFrom(agent.messages, action.turnId) !== 1) setPending(action);
    else void run(action);
  };

  useEffect(() => {
    if (!reask) return;
    setReask(null);
    request(reask);
  });

  const count = pending ? turnsFrom(agent.messages, pending.turnId) : 0;
  const confirm = () => {
    const action = pending;
    setPending(null);
    if (action) void run(action);
  };

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count === 0
              ? "That turn is no longer in the conversation"
              : pending?.kind === "delete"
                ? `Delete ${turns(count)}?`
                : `Remove ${turns(count - 1)} after this one?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {count === 0
              ? "The conversation changed since it was shown; it has been read again."
              : pending?.kind === "delete"
                ? "This turn and every later one are removed from the conversation, for the agent too. Your workspace files are not affected."
                : `${pending?.kind === "retry" ? "Retrying" : "Resending"} replaces this turn and removes the ${turns(count - 1)} after it, for the agent too. Your workspace files are not affected.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {count > 0 && (
            <AlertDialogAction variant="destructive" onClick={confirm}>
              {pending?.kind === "delete" ? "Delete" : pending?.kind === "retry" ? "Retry" : "Resend"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    deleteFrom: (turnId) => request({ kind: "delete", turnId }),
    retry: (turnId, text) => request({ kind: "retry", turnId, text }),
    editResend: (turnId, text) => request({ kind: "edit", turnId, text }),
    dialog,
  };
}
