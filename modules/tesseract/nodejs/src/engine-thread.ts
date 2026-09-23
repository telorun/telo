import { Worker } from "node:worker_threads";
import type { EngineJob, EngineReply, EngineRequest, EngineWorkerData } from "./engine-worker.js";
import { EngineLostError, type PoolEngine } from "./recognition-pool.js";
import type { RecognizedPage } from "./recognition-result.js";

/** An engine that could not start: its code is `ERR_MODEL_DATA_INVALID` for a
 *  model the engine could not load, `ERR_OCR_ENGINE_FAILED` otherwise. */
export class EngineStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EngineStartError";
  }
}

/** The main thread's handle on one engine worker. */
export class EngineThread implements PoolEngine<EngineJob, RecognizedPage> {
  private readonly pending = new Map<
    number,
    { resolve: (page: RecognizedPage) => void; reject: (error: Error) => void }
  >();
  private readonly lostListeners: ((cause: Error) => void)[] = [];
  private nextId = 0;
  private terminating = false;
  private lost: Error | undefined;

  private constructor(
    private readonly worker: Worker,
    private readonly fail: (code: string, message: string) => Error,
  ) {
    worker.on("message", (reply: EngineReply) => this.receive(reply));
    worker.on("error", (error) => this.lose(`the engine worker failed: ${error.message}`));
    worker.on("exit", (code) => this.lose(`the engine worker exited with code ${code}`));
  }

  /**
   * Start a worker running this module's own bundle as the engine, and resolve
   * once it has loaded the engine and every model.
   *
   * `onOutput` receives anything the worker writes to its own stdout or stderr
   * where the runtime pipes a worker's streams; the engine's own output never
   * reaches them, since the worker captures it per call.
   */
  static start(
    data: EngineWorkerData,
    fail: (code: string, message: string) => Error,
    onOutput: (line: string) => void,
  ): Promise<EngineThread> {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: data,
      stdout: true,
      stderr: true,
    });
    // Bun offers no piped worker streams; the engine's own output is captured
    // inside the worker either way.
    for (const stream of [worker.stdout, worker.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      // A chunk may end mid-line; hold the tail until its newline arrives.
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
    return new Promise<EngineThread>((resolve, reject) => {
      // Only this function's own listeners come off: Node's worker keeps
      // listeners of its own that deliver messages.
      const detach = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const refuse = (error: EngineStartError) => {
        detach();
        worker.terminate().then(
          () => reject(error),
          (stopError: unknown) =>
            reject(
              new EngineStartError(
                error.code,
                `${error.message} Stopping its worker then failed too: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
              ),
            ),
        );
      };
      const onMessage = (reply: EngineReply) => {
        detach();
        if (reply.type === "ready") return resolve(new EngineThread(worker, fail));
        if (reply.type === "init-failed") return refuse(new EngineStartError(reply.code, reply.message));
        refuse(new EngineStartError("ERR_OCR_ENGINE_FAILED", `The engine worker sent '${reply.type}' before it was ready.`));
      };
      const onError = (error: Error) =>
        refuse(new EngineStartError("ERR_OCR_ENGINE_FAILED", `The engine worker failed to start: ${error.message}`));
      const onExit = (code: number) =>
        refuse(new EngineStartError("ERR_OCR_ENGINE_FAILED", `The engine worker exited with code ${code} while starting.`));
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  }

  run(job: EngineJob): Promise<RecognizedPage> {
    if (this.lost) return Promise.reject(new EngineLostError(this.lost.message));
    const id = this.nextId++;
    return new Promise<RecognizedPage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...job, id } satisfies EngineRequest);
    });
  }

  async terminate(): Promise<void> {
    this.terminating = true;
    await this.worker.terminate();
  }

  onLost(listener: (cause: Error) => void): void {
    this.lostListeners.push(listener);
  }

  private receive(reply: EngineReply): void {
    if (reply.type === "fatal") {
      this.lose(reply.message);
      return;
    }
    if (reply.type !== "result" && reply.type !== "error") return;
    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);
    if (reply.type === "result") waiting.resolve(reply.page);
    else waiting.reject(this.fail(reply.code, reply.message));
  }

  private lose(message: string): void {
    if (this.lost) return;
    this.lost = new EngineLostError(message);
    for (const waiting of this.pending.values()) waiting.reject(this.lost);
    this.pending.clear();
    if (this.terminating) return;
    for (const listener of this.lostListeners) listener(this.lost);
  }
}
