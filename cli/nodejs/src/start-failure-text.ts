import { errorValueOf, failureFrameLine, type ErrorValue } from "@telorun/sdk";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * A failed start as one human text: the failure, its Telo trace (files relative to the
 * working directory) and, for an uncoded failure only, the host stack — what the log's
 * `pretty` encoding shows for an error (`kernel/specs/logging.md` §11.2).
 */
export function startFailureText(err: unknown, workingDirectory = process.cwd()): string {
  const file = (module: string): string => {
    const local = module.startsWith("file://") ? safeFileUrlToPath(module) : path.isAbsolute(module) ? module : undefined;
    return local === undefined ? module : path.relative(workingDirectory, local).split(path.sep).join("/");
  };
  const error = errorValueOf(err, { file });
  const lines = [`${error.type}: ${error.message}`];
  const body = (entry: ErrorValue): void => {
    const trace = entry.frames
      ? entry.frames.map((frame) =>
          failureFrameLine(frame, frame.module === undefined ? undefined : file(frame.module)),
        )
      : [];
    for (const line of trace) lines.push(`  ${line}`);
    if (entry.hostStack) {
      lines.push("  host stack");
      for (const line of entry.hostStack.split("\n")) lines.push(`    ${line}`);
    }
  };
  body(error);
  for (let cause = error.cause; cause; cause = cause.cause) {
    lines.push(`caused by ${cause.type}: ${cause.message}`);
    body(cause);
  }
  return lines.join("\n");
}

function safeFileUrlToPath(url: string): string | undefined {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}
