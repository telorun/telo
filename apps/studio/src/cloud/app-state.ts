import { useCallback, useEffect, useRef, useState } from "react";
import type { AppDeploymentState, CloudApi, PublishedModuleVersion } from "./api";
import { deploymentFinished } from "./deployment-progress";
import { repositoryRefusalMessage } from "./refusal-messages";

/** How often the state of a module's app is read while its Cloud view is open. */
const STATE_POLL_MS = 10_000;
/** While a deployment is under way the stages are read more often. */
const BUSY_POLL_MS = 3_000;

export interface CloudAppState {
  /** `loading` until first read; `absent` when the project has no app of the
   *  module: an application gets its app when it is first published. */
  status: "loading" | "absent" | "ready" | "failed";
  state: AppDeploymentState | null;
  /** The module's published versions, newest first. */
  versions: PublishedModuleVersion[];
  /** Why the last read failed; what was read before it stays shown. */
  error: string | null;
  /** Reads again now: after an action, so its effect shows at once. */
  refresh(): void;
}

/** The app of the module at `modulePath` among the project's apps. */
export function appOfModule(
  apps: readonly AppDeploymentState[],
  modulePath: string,
): AppDeploymentState | null {
  return apps.find((entry) => entry.app.modulePath === modulePath) ?? null;
}

function newestFirst(versions: PublishedModuleVersion[]): PublishedModuleVersion[] {
  return [...versions].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * What runs of one module in Telo Cloud, read while mounted: the module's app,
 * its environment in each stage with the deployment that serves and the newest
 * one, and the versions the module has published. Polled — every ten seconds,
 * every three while a deployment is under way, and when the window gains focus
 * — because another person, or the console, changes it too.
 */
export function useCloudApp(
  api: CloudApi,
  projectId: string | null,
  modulePath: string,
  enabled: boolean,
): CloudAppState {
  const [status, setStatus] = useState<CloudAppState["status"]>("loading");
  const [state, setState] = useState<AppDeploymentState | null>(null);
  const [versions, setVersions] = useState<PublishedModuleVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const busyRef = useRef(false);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    setStatus("loading");
    setState(null);
    setVersions([]);
    setError(null);
  }, [modulePath, projectId]);

  useEffect(() => {
    if (!projectId || !enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    // A focus during a read: read once more when it ends, never beside it.
    let again = false;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const found = appOfModule(await api.getDeploymentState(projectId), modulePath);
        const published =
          found?.app.moduleId != null
            ? newestFirst(await api.listModuleVersions(projectId, found.app.moduleId))
            : [];
        if (stopped) return;
        busyRef.current =
          found?.environments.some(
            (entry) =>
              entry.latestDeployment !== null &&
              !deploymentFinished(entry.latestDeployment.status),
          ) ?? false;
        setState(found);
        setVersions(published);
        setStatus(found ? "ready" : "absent");
        setError(null);
      } catch (err) {
        if (stopped) return;
        setError(repositoryRefusalMessage(err));
        setStatus((current) => (current === "loading" ? "failed" : current));
      } finally {
        reading = false;
      }
      if (stopped) return;
      if (again) {
        again = false;
        void read();
        return;
      }
      timer = setTimeout(() => void read(), busyRef.current ? BUSY_POLL_MS : STATE_POLL_MS);
    };
    void read();
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [api, enabled, modulePath, projectId, tick]);

  return { status, state, versions, error, refresh };
}
