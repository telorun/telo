import { useEffect, useState } from "react";
import {
  CloudApiError,
  type CloudApi,
  type Deployment,
  type DeploymentEvent,
  type DeploymentStatus,
  type PublicationDeploy,
} from "./api";
import { repositoryRefusalMessage } from "./refusal-messages";

const FINISHED: ReadonlySet<DeploymentStatus> = new Set([
  "healthy",
  "failed",
  "canceled",
  "superseded",
]);

/** How long after a stream ended, or a read failed, the deployment is asked for again. */
const RETRY_MS = 2_000;

export function deploymentFinished(status: DeploymentStatus): boolean {
  return FINISHED.has(status);
}

/** A deployment's status in words. */
export const DEPLOYMENT_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: "Queued",
  resolving: "Resolving",
  applying: "Applying",
  progressing: "Rolling out",
  healthy: "Healthy",
  failed: "Failed",
  canceled: "Canceled",
  superseded: "Superseded",
};

export interface DeploymentProgress {
  /** Null until first read. */
  deployment: Deployment | null;
  /** The steps Cloud reported, in order. */
  events: DeploymentEvent[];
  /** Why the deployment cannot be followed, when Cloud refuses the read. */
  error: string | null;
  /** Why the last attempt to reach Cloud failed, while it is tried again. */
  retrying: string | null;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Follows one deployment until it is finished or `signal` aborts: its events
 * as Cloud streams them, and the deployment itself read again whenever the
 * stream reports a step or ends. The stream ends on its own when the
 * credential it was opened with expires and when a connection drops; either
 * way it is reopened after the last event seen, so no step is reported twice
 * and none is lost. A read Cloud refuses (the deployment is gone, the role
 * was taken away) ends the following with its reason.
 */
export async function followDeployment(
  api: CloudApi,
  projectId: string,
  deploymentId: string,
  onProgress: (progress: DeploymentProgress) => void,
  signal: AbortSignal,
  retryMs: number = RETRY_MS,
): Promise<void> {
  const progress: DeploymentProgress = { deployment: null, events: [], error: null, retrying: null };
  const report = () => onProgress({ ...progress, events: [...progress.events] });
  // Kept per event, not per connection: one that drops has still delivered.
  let lastSeq: number | null = null;
  let reading: Promise<void> = Promise.resolve();
  const read = async () => {
    progress.deployment = await api.getDeployment(projectId, deploymentId);
    progress.retrying = null;
    report();
  };
  const stream = (onStep: () => void) =>
    api.streamDeploymentEvents(
      projectId,
      deploymentId,
      lastSeq,
      (event) => {
        lastSeq = event.seq;
        progress.events.push(event);
        report();
        onStep();
      },
      signal,
    );

  while (!signal.aborted) {
    try {
      await read();
      if (progress.deployment && deploymentFinished(progress.deployment.status)) {
        // Whatever the stream still holds of a finished deployment is its last steps.
        await stream(() => undefined);
        return;
      }
      await stream(() => {
        // One read at a time, in order: the last one read is the newest.
        reading = reading.then(read).catch(() => undefined);
      });
      await reading;
    } catch (err) {
      if (signal.aborted) return;
      // An answer is final; anything else (no connection, Cloud busy, too many
      // requests) is tried again, and shown meanwhile.
      if (err instanceof CloudApiError && err.status < 500 && err.status !== 429) {
        progress.error = repositoryRefusalMessage(err);
        report();
        return;
      }
      progress.retrying = repositoryRefusalMessage(err);
      report();
    }
    await pause(retryMs, signal);
  }
}

/** The progress of the deployment `deploymentId` names, followed while mounted. */
export function useDeploymentProgress(
  api: CloudApi,
  projectId: string | null,
  deploymentId: string | null,
): DeploymentProgress {
  const [progress, setProgress] = useState<DeploymentProgress>({
    deployment: null,
    events: [],
    error: null,
    retrying: null,
  });
  useEffect(() => {
    setProgress({ deployment: null, events: [], error: null, retrying: null });
    if (!projectId || !deploymentId) return;
    const controller = new AbortController();
    void followDeployment(api, projectId, deploymentId, setProgress, controller.signal);
    return () => controller.abort();
  }, [api, deploymentId, projectId]);
  return progress;
}

/** Why a publication's deploy started no deployment, by its `error.code`. */
export function deployFailureMessage(error: NonNullable<PublicationDeploy["error"]>): string {
  switch (error.code) {
    case "module_not_application":
      return "The module is a library, so there is nothing to deploy. It is published.";
    case "invalid_stage":
      return "The stage was deleted before the deployment could start. The version is published: deploy it to another stage.";
    case "environment_not_found":
      return "The application has no environment in that stage. The version is published: a project admin adds the environment in the Telo Cloud console.";
    case "environment_suspended":
      return "The application is stopped in that stage. The version is published: start the environment in the Telo Cloud console, then deploy it.";
    case "insufficient_role":
      return "The stage became protected, and deploying to a protected stage needs the project role admin. The version is published: a project admin can deploy it.";
    case "subscription_ended":
      return "The hosting subscription the stage runs on has ended. The version is published.";
    case "deploy_timeout":
      return "Telo Cloud did not start the deployment in time. The version is published: deploy it from the Cloud view.";
    default:
      // The placement's own refusals carry the sentence that says what to change.
      return error.message ?? `The deployment was not started (${error.code}). The version is published.`;
  }
}

/** What a refused deployment action tells the user. */
export function deploymentRefusalMessage(err: unknown): string {
  if (!(err instanceof CloudApiError)) return repositoryRefusalMessage(err);
  switch (err.code) {
    case "insufficient_role":
      return "Your role in this project does not allow that: a protected stage needs the project role admin.";
    case "environment_suspended":
      return "The application is stopped in this stage. Start it in the Telo Cloud console first.";
    case "no_rollback_candidate":
      return "There is no earlier healthy deployment to go back to.";
    case "version_not_published":
      return "That version of the module is not published.";
    case "source_has_no_deployment":
      return "The stage to promote from has nothing deployed.";
    case "source_deployment_changed":
      return "The stage to promote from was deployed to in the meantime. Look again, then promote.";
    case "no_current_deployment":
      return "Nothing is deployed here yet.";
    case "deployment_not_cancelable":
      return "The deployment is already being applied and can no longer be canceled.";
    default:
      return repositoryRefusalMessage(err);
  }
}
