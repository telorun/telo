import { installOutput, Output } from "../output.js";

/**
 * What `write` prints through the `Output` seam, as plain text: the diagnostics
 * of a boot refusal, read again to be shown in the desktop host's window. Both
 * streams are read, uncoloured, in the order they were written.
 */
export function captureOutput(write: () => void): string {
  const chunks: string[] = [];
  const recorder = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
  const restore = installOutput(new Output({ format: "text", stdout: recorder, stderr: recorder, env: {} }));
  try {
    write();
  } finally {
    restore();
  }
  return chunks.join("").trimEnd();
}
