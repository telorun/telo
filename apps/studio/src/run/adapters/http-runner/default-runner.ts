const HOSTED_RUNNER_URL = "https://runner.telo.run";

/** The runner Studio seeds: the hosted one, or — when the build names one
 *  (`VITE_TELO_RUNNER_URL`, as the development stack does) — that runner, named
 *  for what it is. */
export function defaultRunnerOf(envUrl: string | undefined): { baseUrl: string; name: string } {
  return envUrl && envUrl.trim() !== ""
    ? { baseUrl: envUrl, name: "Development runner" }
    : { baseUrl: HOSTED_RUNNER_URL, name: "Telo Cloud" };
}

export const DEFAULT_RUNNER = defaultRunnerOf(
  (import.meta.env as Record<string, string | undefined>).VITE_TELO_RUNNER_URL,
);
