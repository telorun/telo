import { Worker } from "node:worker_threads";
import { ErrorGroups } from "./error-groups.js";
import { LatencyHistogram } from "./latency-histogram.js";
import {
  LOAD_WORKER,
  type LoadCommand,
  type LoadWorkerData,
  type LoadWorkerReply,
  type LoadWorkerResult,
  type PreparedRequest,
} from "./load-worker.js";
import { evenShares, weightedCycle } from "./request-mix.js";

/** A request with no response in this long counts as an error. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface LoadPassOptions {
  mode: "throughput" | "rate";
  requests: PreparedRequest[];
  weights: number[];
  concurrency: number;
  /** Requests per second over all threads (rate mode). */
  rate: number;
  warmupMs: number;
  durationMs: number;
  /** One generator thread per CPU, at most one per connection. */
  generatorCpus: number;
  signal: AbortSignal | undefined;
  /** Called when the measured window opens, when it closes, and once every measured request has finished. */
  onWindow: (edge: "open" | "close" | "drained") => void;
}

export interface LoadPassResult {
  measured: number;
  responses: number;
  windowMs: number;
  latency: LatencyHistogram;
  errors: ErrorGroups;
}

class GeneratorThread {
  private readonly replies: LoadWorkerReply[] = [];
  private waiting: ((reply: LoadWorkerReply) => void) | undefined;
  private lost: Error | undefined;
  private failWaiting: ((error: Error) => void) | undefined;

  constructor(private readonly worker: Worker) {
    worker.on("message", (reply: LoadWorkerReply) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(reply);
      } else {
        this.replies.push(reply);
      }
    });
    const lose = (error: Error) => {
      this.lost ??= error;
      this.failWaiting?.(this.lost);
    };
    worker.on("error", (error) => lose(new Error(`a load generator thread failed: ${error.message}`)));
    worker.on("exit", (code) => lose(new Error(`a load generator thread exited with code ${code}`)));
  }

  next(): Promise<LoadWorkerReply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.lost) return Promise.reject(this.lost);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failWaiting = reject;
    });
  }

  async expect<T extends LoadWorkerReply["type"]>(type: T): Promise<Extract<LoadWorkerReply, { type: T }>> {
    const reply = await this.next();
    if (reply.type === "failed") throw new Error(`a load generator thread failed: ${reply.message}`);
    if (reply.type !== type) throw new Error(`a load generator thread answered ${reply.type}, expected ${type}`);
    return reply as Extract<LoadWorkerReply, { type: T }>;
  }

  send(command: LoadCommand): void {
    this.worker.postMessage(command);
  }

  async terminate(): Promise<void> {
    this.worker.removeAllListeners("exit");
    this.worker.removeAllListeners("error");
    await this.worker.terminate();
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs one load pass over generator threads and merges what they measured. */
export async function runLoadPass(options: LoadPassOptions): Promise<LoadPassResult> {
  const threadCount = Math.max(1, Math.min(options.generatorCpus, options.concurrency));
  const connections = evenShares(options.concurrency, threadCount);
  const cycle = weightedCycle(options.weights);
  const threads: GeneratorThread[] = [];
  try {
    for (let i = 0; i < threadCount; i++) {
      const data: LoadWorkerData = {
        [LOAD_WORKER]: true,
        mode: options.mode,
        requests: options.requests,
        cycle,
        cycleOffset: Math.floor((i * cycle.length) / threadCount),
        connections: connections[i],
        rate: options.rate / threadCount,
        phaseMs: (i * 1000) / Math.max(options.rate, 1),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      };
      threads.push(new GeneratorThread(new Worker(new URL(import.meta.url), { workerData: data })));
    }
    await Promise.all(threads.map((t) => t.expect("ready")));

    for (const t of threads) t.send({ type: "start" });
    await delay(options.warmupMs, options.signal);
    options.onWindow("open");
    const opened = performance.now();
    for (const t of threads) t.send({ type: "measure" });
    await delay(options.durationMs, options.signal);
    for (const t of threads) t.send({ type: "stop" });
    const windowMs = performance.now() - opened;
    options.onWindow("close");

    const results: LoadWorkerResult[] = await Promise.all(threads.map((t) => t.expect("result")));
    options.onWindow("drained");
    const latency = new LatencyHistogram();
    const errors = new ErrorGroups();
    let measured = 0;
    let responses = 0;
    for (const r of results) {
      latency.merge(r.latency);
      errors.merge(r.errors);
      measured += r.measured;
      responses += r.responses;
    }
    return { measured, responses, windowMs, latency, errors };
  } finally {
    await Promise.all(threads.map((t) => t.terminate()));
  }
}
