import { SEVERITY } from "@telorun/sdk";
import { ConsoleSink } from "./console-sink.js";
import type { LogSinkInstance } from "./log-sink.js";

/**
 * The pre-manifest console writer — `kernel/specs/logging.md` §12.3.
 *
 * Records emitted before the manifest is parsed — loader and parse diagnostics —
 * cannot consult a `logging:` block that does not yet exist. During that phase
 * the runtime uses a fixed default of `info` on an internal writer, and switches
 * to the declared configuration as soon as the manifest resolves. This is the
 * only phase not manifest-governed, and it is not configurable by other means.
 *
 * The writer is kernel-internal and is deliberately **not** a
 * `Telo.ConsoleSink` resource — it exists precisely because no resource can yet.
 * It is also what makes D3 hold: because the pre-manifest window is covered
 * unconditionally, declared sinks are free to be resources that attach later,
 * with buffered records replayed into them.
 */

export const BOOTSTRAP_SINK_ID = "<bootstrap>";

export function createBootstrapWriter(options: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): LogSinkInstance {
  return new ConsoleSink({
    sinkId: BOOTSTRAP_SINK_ID,
    level: SEVERITY.info,
    destination: "stderr",
    encoding: "auto",
    color: "auto",
    env: options.env,
    stdout: options.stdout,
    stderr: options.stderr,
  });
}
