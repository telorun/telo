import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Publication } from "../../cloud/api";
import { useCloud } from "../../cloud/context";
import { publicationFailureMessage } from "../../cloud/refusal-messages";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export interface PublishTarget {
  /** The module's display name. */
  name: string;
  /** The directory of its `telo.yaml`, relative to the repository root. */
  modulePath: string;
}

interface PublishDialogProps {
  target: PublishTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Opens the module's manifest, where `metadata.version` is. */
  onOpenManifest: () => void;
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        title={`Copy ${label.toLowerCase()}`}
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => toast.success("Copied"),
            (err: unknown) =>
              toast.error(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`),
          )
        }
      >
        <Copy />
      </Button>
    </div>
  );
}

/** A diagnostic as Cloud reports it for an invalid manifest; shown as it came. */
function diagnosticLine(diagnostic: unknown): string {
  if (typeof diagnostic === "string") return diagnostic;
  if (typeof diagnostic !== "object" || diagnostic === null) return String(diagnostic);
  const d = diagnostic as { code?: unknown; message?: unknown; path?: unknown };
  const parts = [d.code, d.path, d.message].filter((part) => typeof part === "string");
  return parts.length > 0 ? parts.join(" — ") : JSON.stringify(diagnostic);
}

/** Publishes one module at the working copy's base commit and follows the
 *  publication until it is published or has failed. Publishing creates no app
 *  and starts no deployment. */
export function PublishDialog({ target, onOpenChange, onOpenManifest }: PublishDialogProps) {
  const { publish } = useCloud();
  const [publication, setPublication] = useState<Publication | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const modulePath = target?.modulePath ?? null;

  useEffect(() => {
    if (modulePath === null) return;
    let stopped = false;
    setPublication(null);
    setFailure(null);
    setRunning(true);
    publish(modulePath, (progress) => {
      if (!stopped) setPublication(progress);
    }).then((result) => {
      if (stopped) return;
      setRunning(false);
      if (result.ok) setPublication(result.publication);
      else setFailure(result.message);
    });
    return () => {
      stopped = true;
    };
  }, [modulePath, publish]);

  if (!target) return null;
  const error = publication?.status === "failed" ? publication.error : null;
  const details = error?.details ?? {};
  const refs = Array.isArray(details.refs) ? (details.refs as unknown[]).map(String) : [];
  const diagnostics = Array.isArray(details.diagnostics) ? (details.diagnostics as unknown[]) : [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish {target.name}</DialogTitle>
          <DialogDescription>
            {running
              ? publication?.status === "running"
                ? "Publishing…"
                : "Waiting for the publisher…"
              : publication?.status === "published"
                ? publication.identical
                  ? "This content was already published — nothing new was pushed."
                  : "Published. Create or update an app with this ref in the Telo Cloud console to deploy it."
                : "Publishing failed."}
          </DialogDescription>
        </DialogHeader>

        {publication?.status === "published" && (
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" />
              {publication.identical ? "Already published" : "Published"}
            </div>
            {publication.ref && <CopyableValue label="Ref" value={publication.ref} />}
            {publication.version && <CopyableValue label="Version" value={publication.version} />}
            {publication.digest && <CopyableValue label="Digest" value={publication.digest} />}
            {publication.integrity && (
              <CopyableValue label="Integrity" value={publication.integrity} />
            )}
          </div>
        )}

        {failure && <p className="text-sm text-destructive">{failure}</p>}
        {error && (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{publicationFailureMessage(error)}</p>
            {refs.length > 0 && (
              <ul className="list-disc pl-5 font-mono text-xs">
                {refs.map((ref) => (
                  <li key={ref} className="break-all">
                    {ref}
                  </li>
                ))}
              </ul>
            )}
            {diagnostics.length > 0 && (
              <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-xs">
                {diagnostics.map((diagnostic, index) => (
                  <li key={index} className="break-words">
                    {diagnosticLine(diagnostic)}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{error.code}</p>
          </div>
        )}

        <DialogFooter>
          {error?.code === "version_content_mismatch" && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenManifest();
                onOpenChange(false);
              }}
            >
              Open metadata.version
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
