import { parseLevelName, type DropCause, type LevelName, type LoggingHost } from "@telorun/sdk";

export type { LoggingHost } from "@telorun/sdk";
import type { LoggingPipeline } from "./logging-pipeline.js";

/**
 * The narrow facade a sink controller sees — `kernel/specs/logging.md` §12.1.
 *
 * A sink is a resource, so its controller runs under an ordinary
 * `ResourceContext`; this is the one extra surface it needs. It is deliberately
 * small: attach, detach, resolve a level, count a drop. Everything else about
 * the pipeline stays private to the kernel, so a third-party sink shipped as a
 * module depends on this contract and nothing deeper.
 */
export function createLoggingHost(
  pipeline: LoggingPipeline,
  scopeThreshold: () => number,
  recordDrop: (sinkId: string, cause: DropCause, count?: number) => void,
): LoggingHost {
  return {
    attach: (sink) => pipeline.attach(sink),
    detach: (sink) => pipeline.detach(sink),
    levelFor: (level) => {
      if (!level) return scopeThreshold();
      const severity = parseLevelName(level as LevelName);
      // The schema constrains `level:` to the six named levels, so an unknown
      // value here means the manifest bypassed validation; fall back rather than
      // throw, because a logging misconfiguration must not break boot.
      return severity ?? scopeThreshold();
    },
    recordDrop,
  };
}
