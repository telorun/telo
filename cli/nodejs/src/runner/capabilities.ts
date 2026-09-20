import type { RunnerCapabilities, SessionConfig } from "@telorun/runner-core";

export interface LocalCapabilitiesOptions {
  /** Whether watch sessions are offered (`telo runner --no-watch-sessions`
   *  turns them off). Advertised and enforced from this one answer. */
  watch: boolean;
}

/**
 * What `telo runner` says about itself on `GET /v1/capabilities`.
 *
 * The document is the contract: the editor renders its config form from
 * `config.schema` and core enforces `features` on the session routes, so
 * everything this runner cannot do is stated here rather than discovered at
 * start.
 *
 * `config.schema` declares NO properties, and that is the honest answer — there
 * is no image to choose and no pull policy to apply. A runner that borrowed the
 * container fields to look familiar would put a field on the form that changes
 * nothing.
 */
export function localRunnerCapabilities(opts: LocalCapabilitiesOptions): RunnerCapabilities {
  return {
    displayName: "Local (telo CLI)",
    description:
      "Runs each application as a `telo run` process on this machine, as the user running the " +
      "runner: no container, no isolation, and ports are bound directly on this host.",
    config: {
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    features: {
      // No PTY: there is no terminal to hand a child process, and a native pty
      // cannot ride inside the single-file executable. Advertised so the route
      // refuses an explicit `tty` instead of handing back a session that claims
      // a terminal it does not have.
      io: ["streams"],
      ports: true,
      watch: opts.watch,
    },
  };
}

/**
 * The enforcing half of the schema above.
 *
 * `config.schema` constrains the editor; this is what holds a client that
 * skipped it to the same answer. Advertising a closed schema and then accepting
 * anything is the half-kept invariant the contract change exists to remove — a
 * client sending `image` is asking for a container, and being told nothing is
 * how it learns the wrong thing.
 */
export function validateLocalRunnerConfig(config: SessionConfig): string | undefined {
  const keys = Object.keys(config);
  if (keys.length === 0) return undefined;
  return (
    `this runner takes no session config, and ${keys.map((k) => `'${k}'`).join(", ")} ` +
    `${keys.length === 1 ? "was" : "were"} sent — it runs a manifest as a local process, ` +
    `so there is no image to choose (see /v1/capabilities).`
  );
}
