import { errorValueOf, type ErrorValue } from "@telorun/sdk";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Normalize any thrown value into the record's structured error —
 * `kernel/specs/logging.md` §4.2. The SDK builds it (so a controller writing an
 * error into an event payload builds the same value); the kernel's part is naming
 * each frame's file relative to the entry module's directory.
 */
export interface ToErrorValueOptions {
  maxDepth?: number;
  /** The entry module's directory; absent, a file is shown as its module source. */
  entryDirectory?: string;
}

/** `censor` replaces every value holding a member its type declares sensitive (a URL's
 *  password) wherever a thrown value is written out (§14). */
export function toErrorValue(thrown: unknown, censor: string, options: ToErrorValueOptions = {}): ErrorValue {
  return errorValueOf(thrown, {
    censor,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    file: relativeModuleFile(options.entryDirectory),
  });
}

/** A module source as a path relative to `directory`; a source that is no file on this
 *  host (an `oci://` module) is shown as it is. */
export function relativeModuleFile(directory: string | undefined): (module: string) => string {
  return (module) => {
    if (directory === undefined) return module;
    const local = localPath(module);
    return local === undefined ? module : toPosix(path.relative(directory, local));
  };
}

export function localPath(module: string): string | undefined {
  if (module.startsWith("file://")) {
    try {
      return fileURLToPath(module);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(module) ? module : undefined;
}

function toPosix(file: string): string {
  return path.sep === "/" ? file : file.split(path.sep).join("/");
}
