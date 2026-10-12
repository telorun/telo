/**
 * Addresses in the Telo Cloud console, for what only the console does: stages
 * and hosting, stopping and deleting. The origin is the session's `consoleUrl`
 * — Cloud names it — and the paths are the console's stable ones. Every helper
 * answers `null` when the session names no console.
 */

function at(consoleUrl: string | null, path: string): string | null {
  if (!consoleUrl) return null;
  try {
    return new URL(path, consoleUrl).toString();
  } catch {
    return null;
  }
}

export function consoleStagesUrl(consoleUrl: string | null, projectId: string): string | null {
  return at(consoleUrl, `/p/${projectId}/stages`);
}

export function consoleAppUrl(
  consoleUrl: string | null,
  projectId: string,
  appId: string,
): string | null {
  return at(consoleUrl, `/p/${projectId}/apps/${appId}`);
}

export function consoleEnvironmentUrl(
  consoleUrl: string | null,
  projectId: string,
  appId: string,
  environmentId: string,
): string | null {
  return at(consoleUrl, `/p/${projectId}/apps/${appId}/env/${environmentId}`);
}
