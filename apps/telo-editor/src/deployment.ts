import type { ApplicationDeployment, DeploymentEnvironment, PortMapping } from "./model";

/** ID of the auto-created environment that every Application gets in v1.
 *  Kept as a constant so callers don't pin the string in multiple places. */
export const LOCAL_ENVIRONMENT_ID = "local";

function freshLocalEnvironment(): DeploymentEnvironment {
  return { id: LOCAL_ENVIRONMENT_ID, name: "Local", env: {} };
}

/** Non-mutating read of the active environment for an Application. Returns a
 *  disposable default `local` environment when no record exists — callers
 *  render against this but must go through `setActiveEnvironmentEnv` to
 *  persist any edits (which is when the record is actually seeded into the
 *  deployments map). */
export function readActiveEnvironment(
  deployments: Record<string, ApplicationDeployment>,
  appFilePath: string | null,
): DeploymentEnvironment {
  if (!appFilePath) return freshLocalEnvironment();
  const app = deployments[appFilePath];
  if (!app) return freshLocalEnvironment();
  return app.environments[app.activeEnvironmentId] ?? freshLocalEnvironment();
}

/** Returns the active environment for an Application, creating the default
 *  `local` environment if none exists. Caller receives the (possibly updated)
 *  `deployments` map and the resolved environment.
 *
 *  Used by both the Deployment view (on mount) and RunContext (before building
 *  a bundle), so every caller gets identical default seeding behavior. */
export function getOrCreateActiveEnvironment(
  deployments: Record<string, ApplicationDeployment>,
  appFilePath: string,
): { deployments: Record<string, ApplicationDeployment>; environment: DeploymentEnvironment } {
  const existing = deployments[appFilePath];
  if (existing) {
    const active = existing.environments[existing.activeEnvironmentId];
    if (active) return { deployments, environment: active };
    // Record exists but active env is missing (corrupt or edited). Reseed.
    const local = freshLocalEnvironment();
    return {
      deployments: {
        ...deployments,
        [appFilePath]: {
          activeEnvironmentId: LOCAL_ENVIRONMENT_ID,
          environments: { ...existing.environments, [LOCAL_ENVIRONMENT_ID]: local },
        },
      },
      environment: local,
    };
  }
  const local = freshLocalEnvironment();
  return {
    deployments: {
      ...deployments,
      [appFilePath]: {
        activeEnvironmentId: LOCAL_ENVIRONMENT_ID,
        environments: { [LOCAL_ENVIRONMENT_ID]: local },
      },
    },
    environment: local,
  };
}

/** Replace the env map of the active environment for an Application.
 *  Seeds a local environment if the Application has no deployment record yet. */
export function setActiveEnvironmentEnv(
  deployments: Record<string, ApplicationDeployment>,
  appFilePath: string,
  env: Record<string, string>,
): Record<string, ApplicationDeployment> {
  const { deployments: seeded, environment } = getOrCreateActiveEnvironment(
    deployments,
    appFilePath,
  );
  const app = seeded[appFilePath]!;
  return {
    ...seeded,
    [appFilePath]: {
      ...app,
      environments: {
        ...app.environments,
        [app.activeEnvironmentId]: { ...environment, env },
      },
    },
  };
}

/** Replace the ports list of the active environment for an Application.
 *  Seeds a local environment if the Application has no deployment record yet. */
export function setActiveEnvironmentPorts(
  deployments: Record<string, ApplicationDeployment>,
  appFilePath: string,
  ports: PortMapping[],
): Record<string, ApplicationDeployment> {
  const { deployments: seeded, environment } = getOrCreateActiveEnvironment(
    deployments,
    appFilePath,
  );
  const app = seeded[appFilePath]!;
  return {
    ...seeded,
    [appFilePath]: {
      ...app,
      environments: {
        ...app.environments,
        [app.activeEnvironmentId]: { ...environment, ports },
      },
    },
  };
}
