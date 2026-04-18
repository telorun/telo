import type { ApplicationDeployment } from "./model";

// Deployment configuration lives under its own localStorage key rather than
// folded into `telo-editor-v2` (the UI-focus `PersistedState`). Keeping them
// separate lets each evolve independently — a schema bump here shouldn't
// force a migration of rootDir/activeView, and vice versa.
const KEY = "telo-editor-deployments-v1";

interface PersistedDeployments {
  byWorkspace: Record<string, Record<string, ApplicationDeployment>>;
}

export function loadDeploymentsForWorkspace(
  rootDir: string,
): Record<string, ApplicationDeployment> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedDeployments;
    return parsed.byWorkspace?.[rootDir] ?? {};
  } catch {
    return {};
  }
}

export function saveDeploymentsForWorkspace(
  rootDir: string,
  deploymentsByApp: Record<string, ApplicationDeployment>,
): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as PersistedDeployments) : { byWorkspace: {} };
    if (!parsed.byWorkspace) parsed.byWorkspace = {};
    parsed.byWorkspace[rootDir] = deploymentsByApp;
    localStorage.setItem(KEY, JSON.stringify(parsed));
  } catch {
    // localStorage may be full or unavailable — fail silently, matching
    // the pattern in storage.ts.
  }
}
