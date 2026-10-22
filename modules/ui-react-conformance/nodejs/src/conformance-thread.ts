import type { ResourceContext } from "@telorun/sdk";
import { Worker } from "node:worker_threads";
import type { WindowJob, WindowOutput, WindowReply } from "./conformance-worker.js";
import type { Problem } from "./problem.js";
import { loadSdk } from "./sdk.js";

/**
 * Run one check in a worker of its own, running this module's own bundle as
 * the window, and stop the worker once it has answered. `onOutput` receives
 * each line the window writes: its console is sent here as messages, and
 * anything else the worker writes arrives on its output where the runtime
 * pipes it.
 */
export function runInWindow(job: WindowJob, onOutput: (line: string) => void): Promise<Problem[]> {
  const worker = new Worker(new URL(import.meta.url), { workerData: job, stdout: true, stderr: true });
  // A runtime may offer no piped worker streams.
  for (const stream of [worker.stdout, worker.stderr]) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    let tail = "";
    const emit = (line: string) => {
      if (line.trim() !== "") onOutput(line);
    };
    stream.on("data", (chunk: string) => {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop()!;
      lines.forEach(emit);
    });
    stream.on("end", () => emit(tail));
  }
  const answered = new Promise<Problem[]>((resolve, reject) => {
    worker.on("message", (message: WindowReply | WindowOutput) => {
      if (message.type === "output") onOutput(message.line);
      else if (message.type === "done") resolve(message.problems);
      else reject(new Error(`The check's window failed: ${message.message}`));
    });
    worker.once("error", (error) => reject(new Error(`The check's window failed: ${error.message}`)));
    worker.once("exit", (code) => reject(new Error(`The check's window stopped with code ${code} before it answered.`)));
  });
  return answered.finally(() => worker.terminate());
}

/** Run a check's job in its window, logging the window's output; a failure of
 *  the window itself — not a problem the check found — is raised as the check's. */
export async function checkInWindow(job: WindowJob, ctx: ResourceContext, owner: string): Promise<Problem[]> {
  try {
    return await runInWindow(job, (line) => ctx.log.debug("Check window output", { line }));
  } catch (error) {
    const sdk = await loadSdk();
    throw new sdk.RuntimeError("ERR_UI_CONFORMANCE_WINDOW_FAILED", `${owner}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
