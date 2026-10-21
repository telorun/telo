/**
 * `TELO_APP_CLI` — whether a packaged executable is its application or the telo
 * CLI it carries.
 *
 * `1` means the CLI; unset or empty means the application; any other value is
 * refused before anything runs, with exit status 2. Every telo start reads it
 * and removes it from its own environment first, whatever its distribution and
 * whether or not it carries a payload, so no kernel, controller or child process
 * ever sees it — a child that should be the CLI is given it again by whoever
 * spawns it. On a telo with no payload it does nothing else.
 *
 * A side-effecting module, evaluated before any other code that could read the
 * environment: import it at the top of each entry point, right after the colour
 * bridge. The verdict is kept, since the variable is gone once read.
 */

export const APP_CLI_ENV = "TELO_APP_CLI";

export type AppCliSwitch =
  | { readonly kind: "application" }
  | { readonly kind: "cli" }
  | { readonly kind: "refused"; readonly message: string };

/** Read `TELO_APP_CLI` out of `env`, removing it. */
export function takeAppCliSwitch(env: NodeJS.ProcessEnv): AppCliSwitch {
  const value = env[APP_CLI_ENV];
  delete env[APP_CLI_ENV];
  if (value === undefined || value === "") return { kind: "application" };
  if (value === "1") return { kind: "cli" };
  return {
    kind: "refused",
    message:
      `${APP_CLI_ENV} is set to '${value}', which telo does not read: set ${APP_CLI_ENV}=1 to run a ` +
      `packaged executable as the telo CLI, or leave it unset or empty to run its application.`,
  };
}

/** This process's reading, taken when the module is first evaluated. */
export const appCliSwitch: AppCliSwitch = takeAppCliSwitch(process.env);
