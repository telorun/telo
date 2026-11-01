/**
 * Why `telo runner` refuses to start under a setting only the container runners
 * read, or `undefined`. A session here runs as the user who started the runner,
 * so a session user it cannot honour is refused rather than ignored.
 */
export function containerRunnerSettingRefusal(env: NodeJS.ProcessEnv, username: string): string | undefined {
  const user = env.RUNNER_SESSION_USER;
  if (user === undefined) return undefined;
  return (
    `RUNNER_SESSION_USER is set ('${user}'), but this runner runs no containers — every session runs as ` +
    `the user who started it (${username}). Unset RUNNER_SESSION_USER.`
  );
}
