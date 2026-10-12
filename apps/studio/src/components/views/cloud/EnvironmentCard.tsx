import { ChevronDown, ChevronRight, ExternalLink, Lock } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type {
  CloudApi,
  Deployment,
  EnvironmentState,
  ProjectRole,
  PublishedModuleVersion,
} from "../../../cloud/api";
import {
  deploymentFinished,
  deploymentRefusalMessage,
  useDeploymentProgress,
} from "../../../cloud/deployment-progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import {
  DeploymentProgressView,
  DeploymentStatusMark,
} from "../../cloud/DeploymentProgressView";
import { ConfigEditor } from "./ConfigEditor";

interface EnvironmentCardProps {
  api: CloudApi;
  projectId: string;
  role: ProjectRole;
  entry: EnvironmentState;
  /** The app's other environments, to promote from. */
  others: EnvironmentState[];
  versions: PublishedModuleVersion[];
  /** This environment's page in the Telo Cloud console, when the session names one. */
  consoleUrl: string | null;
  onChanged: () => void;
}

/** An action that asks first: what it is called and what it does. */
interface Confirmation {
  title: string;
  description: string;
  action: string;
  run: () => Promise<Deployment>;
}

const HEALTH_LABEL: Record<EnvironmentState["environment"]["health"], string> = {
  unknown: "Health not known yet",
  healthy: "Running",
  degraded: "Degraded",
  missing: "Not running",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: (open: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon className="size-3.5" />
        {title}
      </button>
      {open && <div className="mt-2">{children(open)}</div>}
    </div>
  );
}

function History({
  api,
  projectId,
  environmentId,
  servingDeploymentId,
  latest,
}: {
  api: CloudApi;
  projectId: string;
  environmentId: string;
  servingDeploymentId: string | null;
  /** The newest deployment and its status: the list is read again when either changes. */
  latest: string | null;
}) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    api.listDeployments(projectId, environmentId).then(
      (list) => {
        if (!stopped) setDeployments(list);
      },
      (err: unknown) => {
        if (!stopped) setError(deploymentRefusalMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [api, environmentId, latest, projectId, servingDeploymentId]);
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!deployments) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (deployments.length === 0)
    return <p className="text-xs text-muted-foreground">Nothing was deployed here yet.</p>;
  return (
    <ul className="space-y-0.5 text-xs">
      {deployments.map((deployment) => (
        <li key={deployment.id} className="flex items-center gap-2">
          <span className="w-36 shrink-0 tabular-nums text-muted-foreground">
            {new Date(deployment.createdAt).toLocaleString()}
          </span>
          <span className="w-24 shrink-0 truncate" title={deployment.source.version}>
            {deployment.source.version}
          </span>
          <DeploymentStatusMark status={deployment.status} />
          {deployment.id === servingDeploymentId && (
            <span className="text-muted-foreground">· serving</span>
          )}
          {deployment.rollbackOfId && <span className="text-muted-foreground">· reverted</span>}
          {deployment.promotedFromId && <span className="text-muted-foreground">· promoted</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * One stage of an application: what serves there, the deployment under way,
 * and what a developer does with it — deploy a published version, go back to
 * the previous one, promote from another stage, restart, apply changed config,
 * cancel a deployment that has not started applying. Stopping and deleting are
 * the console's.
 */
export function EnvironmentCard({
  api,
  projectId,
  role,
  entry,
  others,
  versions,
  consoleUrl,
  onChanged,
}: EnvironmentCardProps) {
  const { environment, currentDeployment, latestDeployment } = entry;
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);

  const running = latestDeployment !== null && !deploymentFinished(latestDeployment.status);
  // The newest deployment is followed while it runs, and shown once it failed:
  // why it failed is what the developer came for.
  const followed =
    latestDeployment !== null && (running || latestDeployment.status === "failed")
      ? latestDeployment.id
      : null;
  const progress = useDeploymentProgress(api, projectId, followed);

  const canAct =
    role === "admin" || (role === "deployer" && !environment.protected);
  const blocked = !canAct
    ? environment.protected
      ? "A protected stage needs the project role admin."
      : "Your role in this project only reads."
    : environment.suspended
      ? "The application is stopped in this stage."
      : null;
  const disabled = busy || blocked !== null;
  const sources = others.filter((other) => other.currentDeployment !== null);

  async function run(action: () => Promise<Deployment>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(deploymentRefusalMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const key = () => crypto.randomUUID();

  return (
    <section
      aria-label={environment.name}
      className="space-y-2 rounded-lg border border-border bg-white p-3 dark:bg-zinc-950"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{environment.name}</h3>
        {environment.protected && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Protected
          </span>
        )}
        <span className="text-xs text-muted-foreground">on {environment.placementName}</span>
        <span className="flex-1" />
        {consoleUrl && (
          <a
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            href={consoleUrl}
            target="_blank"
            rel="noreferrer"
            title="Scale, stop, delete and settings are in the Telo Cloud console"
          >
            Console
            <ExternalLink className="size-3" />
          </a>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {currentDeployment ? (
          <>
            <span>
              Serving version <span className="font-medium">{currentDeployment.version}</span>
            </span>
            <span className="text-muted-foreground">
              {environment.suspended ? "Stopped" : HEALTH_LABEL[environment.health]}
              {environment.readyReplicas !== null &&
                !environment.suspended &&
                ` · ${environment.readyReplicas}/${environment.replicas} ready`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Nothing is deployed here yet.</span>
        )}
        {environment.configChangedSinceDeploy && currentDeployment && (
          <span className="text-amber-700 dark:text-amber-300">
            Variables or secrets changed since this deployment.
          </span>
        )}
      </div>

      {followed && (
        <div className="rounded-lg border border-border p-2">
          <DeploymentProgressView progress={progress} />
          {running &&
            (latestDeployment.status === "queued" || latestDeployment.status === "resolving") && (
              <Button
                className="mt-2"
                variant="outline"
                size="xs"
                disabled={disabled}
                onClick={() => void run(() => api.cancelDeployment(projectId, latestDeployment.id))}
              >
                Cancel deployment
              </Button>
            )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={version} onValueChange={setVersion} disabled={disabled}>
          <SelectTrigger size="sm" className="w-40" aria-label="Version to deploy">
            <SelectValue placeholder="Version" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((published) => (
              <SelectItem key={published.id} value={published.version}>
                {published.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="xs"
          disabled={disabled || version === ""}
          onClick={() => {
            const chosen = version;
            const idempotencyKey = key();
            void run(() => api.deploy(projectId, environment.id, chosen, idempotencyKey));
          }}
        >
          Deploy
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={disabled || currentDeployment === null}
          onClick={() => {
            const idempotencyKey = key();
            setConfirming({
              title: `Revert ${environment.name} to the previous version?`,
              description:
                "Telo Cloud deploys the newest healthy deployment before the one that serves now, exactly as it was: its version, config and secrets.",
              action: "Revert",
              run: () => api.rollback(projectId, environment.id, idempotencyKey),
            });
          }}
        >
          Revert to previous version
        </Button>
        {sources.map((source) => (
          <Button
            key={source.environment.id}
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={() => {
              const idempotencyKey = key();
              const sourceDeployment = source.currentDeployment!;
              setConfirming({
                title: `Promote ${source.environment.name} to ${environment.name}?`,
                description: `Version ${sourceDeployment.version}, as it serves in ${source.environment.name}, is deployed to ${environment.name} with ${environment.name}'s own variables and secrets.`,
                action: "Promote",
                run: () =>
                  api.promote(
                    projectId,
                    environment.id,
                    {
                      sourceEnvironmentId: source.environment.id,
                      sourceDeploymentId: sourceDeployment.id,
                    },
                    idempotencyKey,
                  ),
              });
            }}
          >
            Promote from {source.environment.name}
          </Button>
        ))}
        <Button
          variant="outline"
          size="xs"
          disabled={disabled || currentDeployment === null}
          onClick={() => {
            const idempotencyKey = key();
            setConfirming({
              title: `Restart ${environment.name}?`,
              description:
                "Every instance is replaced by a new one, one at a time. Nothing else changes: changed variables and secrets stay pending.",
              action: "Restart",
              run: () => api.restart(projectId, environment.id, idempotencyKey),
            });
          }}
        >
          Restart
        </Button>
        {environment.configChangedSinceDeploy && currentDeployment && (
          <Button
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={() => {
              const idempotencyKey = key();
              void run(() => api.redeploy(projectId, environment.id, idempotencyKey));
            }}
          >
            Apply changed variables
          </Button>
        )}
      </div>

      <Section title="Variables and secrets">
        {() => (
          <ConfigEditor
            api={api}
            projectId={projectId}
            environmentId={environment.id}
            canEdit={canAct}
            onChanged={onChanged}
          />
        )}
      </Section>
      <Section title="Deployments">
        {() => (
          <History
            api={api}
            projectId={projectId}
            environmentId={environment.id}
            servingDeploymentId={environment.currentDeploymentId}
            latest={latestDeployment ? `${latestDeployment.id}:${latestDeployment.status}` : null}
          />
        )}
      </Section>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const confirmed = confirming;
                setConfirming(null);
                if (confirmed) void run(confirmed.run);
              }}
            >
              {confirming?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
