import * as fs from "fs/promises";
import * as path from "path";

/**
 * The JSONL file sink for `--debug`: one wire-format event per line, appended to
 * `<manifest-dir>/.telo.debug.jsonl`. A pure writer — it does not serialize (that's
 * `debug-serialize.ts`, shared with the SSE server) and does not subscribe to the
 * kernel (the caller owns the single `kernel.on("*")` tap and fans each
 * already-serialized line to both this and the `DebugServer`).
 */
export class DebugEventSubscriber {
  constructor(private readonly filePath: string) {}

  /** Create the directory and truncate the file so each run starts fresh. */
  async open(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, "", "utf-8");
  }

  /** Append one pre-serialized wire line. A write failure is reported, not fatal. */
  async write(line: string): Promise<void> {
    try {
      await fs.appendFile(this.filePath, line + "\n", "utf-8");
    } catch (error) {
      console.error("Failed to write event to debug log:", error);
    }
  }
}
