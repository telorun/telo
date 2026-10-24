import { describe, expect, it } from "vitest";

import { loadCoreConfig, requireStateDirectory, RunnerConfigError } from "./config.js";
import { openSessionStore } from "./session-store/open-session-store.js";

describe("core config", () => {
  it("reads the session settings under their names, with their defaults", () => {
    const defaults = loadCoreConfig({});
    expect(defaults.maxSessions).toBe(8);
    expect(defaults.sessions).toEqual({
      idleMs: 300_000,
      maxRunningSeconds: 21_600,
      retentionMs: 2_592_000_000,
      reloadLimitPerMinute: 30,
    });
    expect(defaults.sessionStore).toEqual({ kind: "sqlite", directory: undefined });

    const set = loadCoreConfig({
      RUNNER_MAX_SESSIONS: "3",
      RUNNER_SESSION_IDLE_SECONDS: "60",
      RUNNER_SESSION_MAX_RUNNING_SECONDS: "7200",
      RUNNER_SESSION_RETENTION_SECONDS: "86400",
      RUNNER_SESSION_RELOAD_LIMIT: "5",
      RUNNER_STATE_DIR: "/var/lib/telo-runner",
    });
    expect(set.maxSessions).toBe(3);
    expect(set.sessions).toEqual({
      idleMs: 60_000,
      maxRunningSeconds: 7200,
      retentionMs: 86_400_000,
      reloadLimitPerMinute: 5,
    });
    expect(set.sessionStore).toEqual({ kind: "sqlite", directory: "/var/lib/telo-runner" });
  });

  it("refuses every retired variable that is set, naming its replacement or saying it is gone", () => {
    const load = () =>
      loadCoreConfig({
        RUNNER_WATCH_SESSIONS: "true",
        RUNNER_WATCH_IDLE_SECONDS: "600",
        RUNNER_EXIT_TTL_MS: "",
      });
    expect(load).toThrow(RunnerConfigError);
    expect(load).toThrow(
      "this runner no longer reads variables its environment sets:\n" +
        "  RUNNER_WATCH_SESSIONS is removed: sessions are always on. Unset it.\n" +
        "  RUNNER_WATCH_IDLE_SECONDS is renamed: set RUNNER_SESSION_IDLE_SECONDS instead.\n" +
        "  RUNNER_EXIT_TTL_MS is removed: one-shot run sessions are removed. Unset it.",
    );
  });

  it("selects the session store, refusing an unknown one and Postgres without a URL", () => {
    const url = "postgres://runner:hunter2@db:5432/runner";
    expect(loadCoreConfig({ RUNNER_SESSION_STORE: "postgres", RUNNER_SESSION_STORE_URL: url }).sessionStore).toEqual({
      kind: "postgres",
      url,
    });
    expect(() => loadCoreConfig({ RUNNER_SESSION_STORE: "postgres" })).toThrow(
      /RUNNER_SESSION_STORE=postgres needs RUNNER_SESSION_STORE_URL/,
    );
    expect(() => loadCoreConfig({ RUNNER_SESSION_STORE: "mysql" })).toThrow(
      "RUNNER_SESSION_STORE must be one of sqlite | postgres, got 'mysql'.",
    );
    expect(() => loadCoreConfig({ RUNNER_SESSION_STORE_URL: url })).toThrow(
      /RUNNER_SESSION_STORE_URL is set, but RUNNER_SESSION_STORE is sqlite/,
    );
    const wrongScheme = () =>
      loadCoreConfig({ RUNNER_SESSION_STORE: "postgres", RUNNER_SESSION_STORE_URL: "mysql://u:hunter2@db/x" });
    expect(wrongScheme).toThrow("must be a postgres:// or postgresql:// URL, got a 'mysql:' one.");
    expect(wrongScheme).not.toThrow(/hunter2/);
  });

  it("keeps the store in the host's resolved state root, which already read RUNNER_STATE_DIR, and a container runner requires one", () => {
    expect(
      loadCoreConfig({ RUNNER_STATE_DIR: "/elsewhere" }, { stateDir: "/home/me/.telo-runner" }).sessionStore,
    ).toEqual({ kind: "sqlite", directory: "/home/me/.telo-runner" });
    expect(() => requireStateDirectory(loadCoreConfig({}).sessionStore)).toThrow(
      /RUNNER_STATE_DIR is required with RUNNER_SESSION_STORE=sqlite/,
    );
    expect(() =>
      requireStateDirectory(
        loadCoreConfig({ RUNNER_SESSION_STORE: "postgres", RUNNER_SESSION_STORE_URL: "postgres://db/x" }).sessionStore,
      ),
    ).not.toThrow();
  });

  it("opens no SQLite store without a state directory", async () => {
    await expect(
      openSessionStore({ kind: "sqlite", directory: undefined }, { log: { error: () => undefined } }),
    ).rejects.toThrow(/set RUNNER_STATE_DIR/);
  });
});

describe("identity config", () => {
  it("reads the audience and the issuers together, and neither means no identity", () => {
    expect(loadCoreConfig({}).identity).toBeUndefined();
    expect(
      loadCoreConfig({
        RUNNER_IDENTITY_AUDIENCE: "https://runner.example.com/r",
        RUNNER_IDENTITY_ISSUERS: "https://id.example, https://login.example/tenant/",
      }).identity,
    ).toEqual({
      audience: "https://runner.example.com/r",
      issuers: ["https://id.example", "https://login.example/tenant/"],
    });
  });

  const AUDIENCE = "https://runner.example.com";
  const ISSUERS = "https://id.example";
  it.each([
    [{ RUNNER_IDENTITY_ISSUERS: ISSUERS }, /set without RUNNER_IDENTITY_AUDIENCE/],
    [{ RUNNER_IDENTITY_AUDIENCE: AUDIENCE }, /set without RUNNER_IDENTITY_ISSUERS/],
    [
      { RUNNER_IDENTITY_AUDIENCE: "http://runner.example.com", RUNNER_IDENTITY_ISSUERS: ISSUERS },
      /audience 'http:\/\/runner.example.com' must be an https URL/,
    ],
    [
      { RUNNER_IDENTITY_AUDIENCE: AUDIENCE, RUNNER_IDENTITY_ISSUERS: "https://id.example,http://other.example" },
      /an issuer 'http:\/\/other.example' must be an https URL/,
    ],
    [
      { RUNNER_IDENTITY_AUDIENCE: `${AUDIENCE}/r?x=1`, RUNNER_IDENTITY_ISSUERS: ISSUERS },
      /must carry no query and no fragment/,
    ],
    [
      { RUNNER_IDENTITY_AUDIENCE: `${AUDIENCE}/r#x`, RUNNER_IDENTITY_ISSUERS: ISSUERS },
      /must carry no query and no fragment/,
    ],
    [
      { RUNNER_IDENTITY_AUDIENCE: `${AUDIENCE}/r/`, RUNNER_IDENTITY_ISSUERS: ISSUERS },
      /must not end with a slash: write 'https:\/\/runner.example.com\/r'/,
    ],
  ])("refuses %o", (env, message) => {
    const load = () => loadCoreConfig(env);
    expect(load).toThrow(RunnerConfigError);
    expect(load).toThrow(message);
  });
});
