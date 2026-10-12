import { useCloudApp } from "../../../cloud/app-state";
import {
  consoleAppUrl,
  consoleEnvironmentUrl,
  consoleStagesUrl,
} from "../../../cloud/console-links";
import { useCloud } from "../../../cloud/context";
import { EnvironmentCard } from "./EnvironmentCard";

interface CloudViewProps {
  /** The module's display name. */
  name: string;
  /** The directory of the module's `telo.yaml` in the project's repository;
   *  "" at its root. Null when the module is not one of the open project's. */
  modulePath: string | null;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-6">
      <p className="max-w-md text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The application as it runs in Telo Cloud: one card per stage of its project,
 * with what serves there, the deployment under way and the actions a developer
 * takes — so publishing, deploying and watching need no visit to the console.
 * What stays there is linked: stages and hosting, scaling, stopping, deleting.
 */
export function CloudView({ name, modulePath }: CloudViewProps) {
  const cloud = useCloud();
  const { active, api, session } = cloud;
  const signedIn = session.status === "signedIn";
  const projectId = active?.projectId ?? null;
  const app = useCloudApp(api, projectId, modulePath ?? "", signedIn && modulePath !== null);
  const consoleUrl = session.status === "signedIn" ? session.identity.consoleUrl : null;

  if (!active || modulePath === null) {
    return (
      <Notice>
        This application is not part of a Telo Cloud project. Open or create one from the workspace
        menu to publish and deploy it.
      </Notice>
    );
  }
  if (!signedIn) {
    return <Notice>Sign in to Telo Cloud to see where {name} runs.</Notice>;
  }
  if (app.status === "loading") return <Notice>Reading Telo Cloud…</Notice>;
  if (app.status === "failed") return <Notice>{app.error}</Notice>;
  if (app.status === "absent" || !app.state) {
    return (
      <Notice>
        {name} is not in Telo Cloud yet. An application gets its app there when it is first
        published: commit it, then use Publish and deploy above.
      </Notice>
    );
  }

  const { state } = app;
  const stagesUrl = consoleStagesUrl(consoleUrl, active.projectId);
  const appUrl = consoleAppUrl(consoleUrl, active.projectId, state.app.id);
  return (
    <div className="flex-1 space-y-3 overflow-y-auto bg-zinc-50 p-4 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="text-sm font-semibold text-foreground">{state.app.name}</span>
        <span>in {active.name}</span>
        <span className="flex-1" />
        {appUrl && (
          <a className="hover:text-foreground" href={appUrl} target="_blank" rel="noreferrer">
            Open in the Telo Cloud console
          </a>
        )}
      </div>
      {app.error && <p className="text-xs text-destructive">{app.error}</p>}
      {state.environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project has no stage, so there is nowhere to deploy to. A project admin adds one{" "}
          {stagesUrl ? (
            <a className="underline" href={stagesUrl} target="_blank" rel="noreferrer">
              in the Telo Cloud console
            </a>
          ) : (
            "in the Telo Cloud console"
          )}
          .
        </p>
      ) : (
        state.environments.map((entry) => (
          <EnvironmentCard
            key={entry.environment.id}
            api={api}
            projectId={active.projectId}
            role={active.role}
            entry={entry}
            others={state.environments.filter(
              (other) => other.environment.id !== entry.environment.id,
            )}
            versions={app.versions}
            consoleUrl={consoleEnvironmentUrl(
              consoleUrl,
              active.projectId,
              state.app.id,
              entry.environment.id,
            )}
            onChanged={app.refresh}
          />
        ))
      )}
    </div>
  );
}
