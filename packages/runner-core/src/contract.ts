/**
 * The `/v1` contract lives in `@telorun/runner-protocol`; this module re-exports
 * it and adds what only a runner needs (the supervision floor, the start-failure
 * error). Backend-specific concerns live behind the `RunnerBackend` interface.
 */

import type { DebugFrame } from "@telorun/debug-wire";
import type { RunEvent as ProtocolRunEvent } from "@telorun/runner-protocol";

export * from "@telorun/runner-protocol";

export type PullPolicy = "missing" | "always" | "never";

/** The event stream, with the kernel's own debug frame type. */
export type RunEvent = ProtocolRunEvent<DebugFrame>;

/** A plain release version, optionally carrying a pre-release and build tag —
 *  what an application's `telo` may name. It becomes an image tag and a release
 *  asset name, so nothing else is admitted. */
export const TELO_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * The oldest telo release a runner supervises.
 *
 * A runner starts an application as `telo run --watch --no-input --inspect <addr>
 * --no-open <entry>` beside a seeded `telo-workspace.yaml`, and reads its run
 * outcomes off the debug stream. A release that predates any of those either
 * fails to start with an error about its own command line, or runs with no
 * generation ever opening — neither of which tells the user the version is
 * simply too old.
 *
 * The floor is the release whose `telo run --watch` takes no hold of its own,
 * so a one-shot application's generation ends — torn down, `Kernel.Stopped`
 * carrying its exit code — and the run is reported `completed`; on an older
 * release that generation never ends until the next edit. It also carries
 * `--no-input` (0.121.0), which every backend passes. It is forward-declared
 * until that release is published, and verified by execution then; raise it
 * only for behaviour a runner starts relying on, and lower it only by running
 * the candidate.
 */
export const MIN_SUPERVISABLE_TELO = "0.123.0";

/** Why `version` is too old to be supervised, or `undefined`. */
export function unsupervisableTelo(version: string): string | undefined {
  const parts = (text: string) => text.split(/[-+]/)[0]!.split(".").map(Number);
  const [asked, floor] = [parts(version), parts(MIN_SUPERVISABLE_TELO)];
  for (let i = 0; i < 3; i++) {
    if (asked[i]! > floor[i]!) return undefined;
    if (asked[i]! < floor[i]!) {
      return (
        `telo ${version} is older than ${MIN_SUPERVISABLE_TELO}, the oldest release a runner ` +
        `is verified to supervise (watch mode and a finished run's outcome, the debug stream, the workspace marker)`
      );
    }
  }
  return undefined;
}

/** Whether a version is a BUILD identity (`X+unreleased`) rather than a release:
 *  a working copy made while `X` was still pending, which no registry and no
 *  release holds under that number. */
export function isUnreleasedTelo(version: string): boolean {
  return version.includes("+");
}

/**
 * Stages a workload creation can fail at. The docker/k8s backends share the
 * vocabulary; not every stage applies to every backend (`pull`/`inspect` are
 * image-availability stages, `create`/`attach`/`start` are workload stages).
 */
export type StartFailureStage =
  | "pull"
  | "inspect"
  | "daemon"
  | "create"
  | "attach"
  | "start";

export class SessionStartError extends Error {
  constructor(
    public readonly kind: "pull_failed" | "start_failed",
    public readonly stage: StartFailureStage,
    message: string,
    public readonly daemonMessage?: string,
  ) {
    super(message);
    this.name = "SessionStartError";
  }
}
