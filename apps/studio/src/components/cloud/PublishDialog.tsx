import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Publication } from "../../cloud/api";
import { useCloud } from "../../cloud/context";
import { deployFailureMessage, useDeploymentProgress } from "../../cloud/deployment-progress";
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
import { DeploymentProgressView } from "./DeploymentProgressView";

export interface PublishTarget {
  /** The module's display name. */
  name: string;
  /** The directory of its `telo.yaml`, relative to the repository root. */
  modulePath: string;
  /** The telo version the module is edited against, which is the one it is
   *  published to run on; or why it has none, which is why it cannot be
   *  published now. */
  telo: { version: string } | { refusal: string };
  /** An application gets its app in Telo Cloud when it is published, and is
   *  what a stage runs; a library is only imported. */
  kind: "Application" | "Library";
  /** The stage Telo Cloud deploys the published version to; absent: none. */
  deployTo?: { stageId: string; stageName: string };
}

interface PublishDialogProps {
  target: PublishTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Opens the module's manifest, where `metadata.version` is. */
  onOpenManifest: () => void;
  /** Opens the module's Cloud view, where what runs in each stage is. */
  onOpenCloudView: () => void;
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
 *  publication until it is published or has failed. Publishing an application
 *  gives it its app in Telo Cloud. With a stage to deploy to, Telo Cloud starts
 *  that deployment itself once the module is published, and the dialog follows
 *  it; closing the dialog stops neither. */
export function PublishDialog({
  target,
  onOpenChange,
  onOpenManifest,
  onOpenCloudView,
}: PublishDialogProps) {
  const { publish, active, api } = useCloud();
  const [publication, setPublication] = useState<Publication | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const modulePath = target?.modulePath ?? null;
  const teloVersion = target && "version" in target.telo ? target.telo.version : null;
  const deployStageId = target?.deployTo?.stageId ?? null;
  const deploy = publication?.status === "published" ? (publication.deploy ?? null) : null;
  const deployment = useDeploymentProgress(
    api,
    active?.projectId ?? null,
    // Followed only while the dialog is open: the Cloud view follows it after.
    target && deploy?.status === "started" ? deploy.deploymentId : null,
  );

  useEffect(() => {
    if (modulePath === null || teloVersion === null) return;
    let stopped = false;
    setPublication(null);
    setFailure(null);
    setRunning(true);
    publish(modulePath, teloVersion, deployStageId, (progress) => {
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
    // The version is the one the dialog opened with: a publication under way
    // is not started again when the editor resolves another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modulePath, deployStageId, publish]);

  if (!target) return null;
  const error = publication?.status === "failed" ? publication.error : null;
  const details = error?.details ?? {};
  const refs = Array.isArray(details.refs) ? (details.refs as unknown[]).map(String) : [];
  const diagnostics = Array.isArray(details.diagnostics) ? (details.diagnostics as unknown[]) : [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target.deployTo
              ? `Publish ${target.name} and deploy to ${target.deployTo.stageName}`
              : `Publish ${target.name}`}
          </DialogTitle>
          <DialogDescription>
            {publication?.status === "published"
              ? publication.identical
                ? "This content was already published — nothing new was pushed."
                : target.kind === "Application" && !target.deployTo
                  ? "Published. Deploy it to a stage from the Cloud view."
                  : "Published."
              : running
                ? publication?.status === "running"
                  ? "Publishing…"
                  : "Waiting for the publisher…"
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
            {publication.teloVersion && (
              <CopyableValue label="Telo" value={publication.teloVersion} />
            )}
            {publication.digest && <CopyableValue label="Digest" value={publication.digest} />}
            {publication.integrity && (
              <CopyableValue label="Integrity" value={publication.integrity} />
            )}
          </div>
        )}

        {deploy && target.deployTo && (
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <div className="text-sm font-medium">Deployment to {target.deployTo.stageName}</div>
            {deploy.status === "pending" && (
              <p className="text-sm text-muted-foreground">Starting the deployment…</p>
            )}
            {deploy.status === "failed" && deploy.error && (
              <div className="space-y-1 text-sm">
                <p className="text-destructive">{deployFailureMessage(deploy.error)}</p>
                <p className="text-xs text-muted-foreground">{deploy.error.code}</p>
              </div>
            )}
            {(deploy.status === "skipped" || (deploy.status === "failed" && !deploy.error)) && (
              <p className="text-sm text-muted-foreground">
                Telo Cloud started no deployment. The version is published: deploy it from the
                Cloud view.
              </p>
            )}
            {deploy.status === "started" && <DeploymentProgressView progress={deployment} />}
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
                  <li key={index} className="wrap-anywhere">
                    {diagnosticLine(diagnostic)}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{error.code}</p>
          </div>
        )}

        <DialogFooter>
          {(error?.code === "version_content_mismatch" ||
            error?.code === "telo_version_mismatch") && (
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
          {publication?.status === "published" && target.kind === "Application" && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenCloudView();
                onOpenChange(false);
              }}
            >
              Open Cloud view
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
