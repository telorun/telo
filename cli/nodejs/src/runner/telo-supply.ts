import { isUnreleasedTelo } from "@telorun/runner-core";

import { releaseBinary, ReleaseBinaryError, type ReleaseBinaryOptions } from "../release-binary.js";
import { selfInvocation, type SelfInvocation } from "./self-invocation.js";

/**
 * Which telo an application runs on, when it names one.
 *
 * The runner's own version is the running executable, as it always was — one
 * version by construction. Any OTHER version is that release's own binary for
 * this platform, fetched and verified by the shared release fetch and
 * supervised in place of this one. Supervising another version is what the
 * container runners already do with a kernel image, and rests on the same rule:
 * every flag the runner passes sits before the manifest path, which every
 * release reads the same way.
 *
 * Nothing is substituted. A version that cannot be had is a refusal carrying
 * the reason, and that reason is what the user is shown.
 */
export interface TeloSupply {
  /** Why `version` can never be run here, known without touching the network —
   *  or `undefined`. What a request is refused with before a session exists. */
  refusal(version: string): string | undefined;
  /** How to invoke telo `version`, downloading its release on first use — the
   *  slow half, which belongs to a session's start, where there is a stream to
   *  report progress on. Rejects with {@link TeloVersionUnavailable}. */
  invocation(version: string, report?: (message: string) => void): Promise<SelfInvocation>;
}

/** A requested telo version this runner cannot run; the message is the reason. */
export class TeloVersionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeloVersionUnavailable";
  }
}

export interface TeloSupplyOptions {
  /** What this telo calls itself: `X`, or `X+unreleased` for a build made while
   *  `X` is still pending. */
  identity: string;
  /** This machine's release-asset target, or `null` where none is published. */
  hostTarget: string | null;
  cacheRoot: string | null;
  fetch?: ReleaseBinaryOptions["fetch"];
}

export function createTeloSupply(options: TeloSupplyOptions): TeloSupply {
  const refusal = (version: string): string | undefined => {
    if (version === options.identity) return undefined;
    // A build identity names a working copy, not a release: there is nothing
    // to download, and the release of the same number is different code.
    if (isUnreleasedTelo(version)) {
      return (
        `${version} is an unreleased build, which only the build it came from can run — ` +
        `this runner is telo ${options.identity}. Pin a released telo version for this workspace`
      );
    }
    if (options.hostTarget === null) {
      return (
        `no telo binary is published for this platform (${process.platform} ${process.arch}), ` +
        `so this runner can run only its own version, ${options.identity}`
      );
    }
    return undefined;
  };
  return {
    refusal,
    async invocation(version, report) {
      const refused = refusal(version);
      if (refused !== undefined) throw new TeloVersionUnavailable(refused);
      if (version === options.identity) return selfInvocation();
      try {
        const file = await releaseBinary(options.hostTarget!, version, {
          cacheRoot: options.cacheRoot,
          report,
          fetch: options.fetch,
        });
        return { command: file, prefix: [] };
      } catch (err) {
        if (err instanceof ReleaseBinaryError) throw new TeloVersionUnavailable(err.message);
        throw err;
      }
    },
  };
}
