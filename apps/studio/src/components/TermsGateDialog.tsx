import { useEffect, useState } from "react";

import type { RunnerTerms } from "../run";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { reflowRunnerTerms } from "./runner-terms-reflow";
import { Checkbox } from "./ui/checkbox";

interface TermsGateDialogProps {
  /** The runner's terms to display, or null when the gate is closed. */
  terms: RunnerTerms | null;
  /** Invoked when the user accepts — the caller persists acceptance and proceeds
   *  with the pending run. */
  onAccept: () => void;
  /** Invoked when the user declines or dismisses (Escape / Decline) — the caller
   *  cancels the pending run. */
  onDecline: () => void;
}

/** A blocking agreement the user must accept before running on a given runner.
 *  The content comes from the runner itself; acceptance is persisted by the
 *  caller (per runner + version) and enforced server-side. */
export function TermsGateDialog({ terms, onAccept, onDecline }: TermsGateDialogProps) {
  const [agreed, setAgreed] = useState(false);
  const open = terms !== null;

  // Reset the checkbox each time the gate reopens so a prior tick can't carry over.
  useEffect(() => {
    if (open) setAgreed(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onDecline()}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{terms?.title ?? "Before you run"}</AlertDialogTitle>
          <AlertDialogDescription>
            This runner requires accepting the following before a session can start.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="max-h-[50vh] space-y-2 overflow-auto rounded-md border bg-muted/30 p-3 text-sm text-foreground">
          {reflowRunnerTerms(terms?.body ?? "").map((block, index) =>
            block.kind === "paragraph" ? (
              <p key={index}>{block.text}</p>
            ) : (
              <ul key={index} className="list-disc space-y-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ul>
            ),
          )}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={agreed}
            onCheckedChange={(checked) => setAgreed(checked === true)}
          />
          <span>I have read and accept the terms above.</span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel>Decline</AlertDialogCancel>
          <Button disabled={!agreed} onClick={onAccept}>
            Accept &amp; continue
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
