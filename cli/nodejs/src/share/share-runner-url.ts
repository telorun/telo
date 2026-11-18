/** The runner `--share` and `telo shares` use when nothing names one. */
export const DEFAULT_RUNNER_URL = "https://runner.telo.run";

export const RUNNER_URL_ENV = "TELO_RUNNER_URL";

/** `--share-runner` / `--runner`, else `TELO_RUNNER_URL`, else the hosted runner. */
export function resolveRunnerUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const chosen = flag?.trim() || env[RUNNER_URL_ENV]?.trim() || DEFAULT_RUNNER_URL;
  return chosen.replace(/\/+$/, "");
}
