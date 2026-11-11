import { useEffect, useState } from "react";

import { useRun } from "../run";
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
import { Checkbox } from "./ui/checkbox";

/** Asks whether an app of a run this page started may open its page in another
 *  tab. Mounted once, where the run context is available; shows one request at
 *  a time, oldest first. An external address always asks and shows its host. */
export function OpenUrlDialog() {
  const { openUrlRequests, answerOpenUrl } = useRun();
  const request = openUrlRequests.find((r) => r.mode === "confirm") ?? null;
  const [always, setAlways] = useState(false);

  useEffect(() => setAlways(false), [request?.id]);

  if (!request) return null;
  const external = request.reach === "external";

  return (
    <AlertDialog open onOpenChange={(next) => !next && answerOpenUrl(request.id, { open: false })}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Open {request.app} in another tab?</AlertDialogTitle>
          <AlertDialogDescription>
            {external ? (
              <>
                The app asked to open a page on another site, <strong className="text-foreground">{request.host}</strong>.
              </>
            ) : (
              "The app asked to open its page."
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border bg-muted/30 p-3 font-mono text-sm break-all text-foreground">{request.address}</div>

        {!external && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={always} onCheckedChange={(checked) => setAlways(checked === true)} />
            <span>Always open this app</span>
          </label>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <Button onClick={() => answerOpenUrl(request.id, { open: true, always: !external && always })}>Open</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
