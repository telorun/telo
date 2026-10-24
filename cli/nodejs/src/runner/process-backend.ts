import * as fs from "node:fs/promises";

import type { AvailabilityReport, RunnerBackend } from "@telorun/runner-core";

import { selfInvocation, type SelfInvocation } from "./self-invocation.js";
import { LocalSessionWorkload } from "./session-workload.js";
import { removeSessionDirectory, sweepSessionDirectories } from "./state-root.js";
import type { TeloSupply } from "./telo-supply.js";

/**
 * The local-process `RunnerBackend`: a session is a directory under the state
 * root, and every Run is a `telo run` of this same executable, on this machine,
 * as this user.
 *
 * It is the third backend behind one `/v1` contract, and the substrate it owns
 * is the `telo` binary itself — which is why it lives in the CLI rather than in
 * the backend-neutral package, exactly as the docker backend lives in the image
 * that fronts a docker socket.
 *
 * What is genuinely different here is advertised rather than hidden:
 *
 *  - **No PTY.** Node has no terminal to hand a child, so every run is
 *    `io: "streams"`; the run route refuses an explicit `tty`.
 *  - **No isolation.** A run inherits this process's environment and runs with
 *    its privileges, which is why the runner binds loopback by default.
 *  - **Ports are bound directly.** An application binds the port it declares,
 *    on this host; there is nothing to publish.
 *  - **Nothing outlives the runner.** There is no `adopt`: core suspends every
 *    stored session at boot, and the directories are resumed from.
 *  - **No co-resident agent.** The runner advertises none.
 */

export interface ProcessBackendDeps {
  /** The state root (`prepareStateRoot`), private to the user. */
  stateRoot: string;
  /** Where the telo an application names comes from when it is not this one. */
  telo: TeloSupply;
  /** Told the names of the session directories the boot sweep removed. */
  onSwept?(names: string[]): void;
  /** How this telo is invoked; the running executable unless a host says
   *  otherwise. */
  self?(): Promise<SelfInvocation>;
}

export function createProcessBackend(deps: ProcessBackendDeps): RunnerBackend {
  const workloadDeps = {
    stateRoot: deps.stateRoot,
    telo: deps.telo,
    self: deps.self ?? (() => selfInvocation()),
  };
  return {
    async probe(): Promise<AvailabilityReport> {
      // Two things have to hold before a session can run: this CLI must know
      // how to re-invoke itself, and the state root must be writable.
      try {
        await workloadDeps.self();
      } catch (err) {
        return {
          status: "unavailable",
          message: messageOf(err),
          remediation: "Run the runner from an installed `telo`, or from the CLI's own entry point.",
        };
      }
      try {
        await fs.access(deps.stateRoot, fs.constants.W_OK);
      } catch (err) {
        return {
          status: "unavailable",
          message: `The runner's state directory '${deps.stateRoot}' is not writable: ${messageOf(err)}.`,
          remediation: "Set --state-dir to a directory this user can write.",
        };
      }
      return { status: "ready" };
    },

    // Only what is known without the network. A release this machine does not
    // hold yet is downloaded by create, which has a stream to report it on.
    async supplyTelo(version) {
      return deps.telo.refusal(version);
    },

    create(spec, callbacks) {
      return LocalSessionWorkload.create(workloadDeps, spec, callbacks);
    },

    async destroy(sessionId) {
      await removeSessionDirectory(deps.stateRoot, sessionId);
    },

    async reapOrphans({ known }) {
      const swept = await sweepSessionDirectories(deps.stateRoot, known);
      if (swept.length > 0) deps.onSwept?.(swept);
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
