import { RunnerConfigError, type SessionStoreConfig } from "../config.js";
import { PostgresSessionStore } from "./postgres-session-store.js";
import type { SessionStore } from "./session-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";

export interface OpenSessionStoreOptions {
  /** Where an error on an idle Postgres connection is reported. */
  log: { error(obj: unknown, msg: string): void };
}

/** Opens the store `RUNNER_SESSION_STORE` names. */
export async function openSessionStore(
  config: SessionStoreConfig,
  options: OpenSessionStoreOptions,
): Promise<SessionStore> {
  if (config.kind === "postgres") {
    return PostgresSessionStore.open(config.url, {
      onIdleClientError: (err) =>
        options.log.error({ err }, "an idle connection to the Postgres session store failed"),
    });
  }
  if (config.directory === undefined) {
    throw new RunnerConfigError(
      "RUNNER_SESSION_STORE=sqlite keeps the session store in the runner's state directory, " +
        "and none is configured: set RUNNER_STATE_DIR to a directory on persistent storage.",
    );
  }
  return SqliteSessionStore.open(config.directory);
}
