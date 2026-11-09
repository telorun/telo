/** The files changed since a base ref: the plain `base...HEAD` name list. */

import { execFileSync } from "node:child_process";

/** Throws when git cannot answer (no merge base, a shallow clone). */
export function changedFilesSinceBase(cwd: string, baseRef: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}
