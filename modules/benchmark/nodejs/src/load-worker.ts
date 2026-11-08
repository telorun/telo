// One HTTP load generator thread. The module's bundle is this worker's entry: it re-enters
// itself with LOAD_WORKER in its worker data, so nothing here may load the SDK.
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Agent, type Dispatcher } from "undici";
import { ErrorGroups, MAX_SAMPLE_LENGTH, type ErrorGroup } from "./error-groups.js";
import { truncate } from "./error-sample.js";
import { LatencyHistogram, type LatencyHistogramSnapshot } from "./latency-histogram.js";

export const LOAD_WORKER = "telo.benchmark.load";

/** A request the worker sends as is: the body already encoded. */
export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** The one accepted status; undefined accepts any 2xx. */
  expectStatus: number | undefined;
}

export interface LoadWorkerData {
  readonly [LOAD_WORKER]: true;
  mode: "throughput" | "rate";
  requests: PreparedRequest[];
  /** Request indices in send order, repeated. */
  cycle: number[];
  cycleOffset: number;
  connections: number;
  /** Requests per second this worker schedules (rate mode). */
  rate: number;
  /** When this worker's first request is due, in ms after start (rate mode). */
  phaseMs: number;
  requestTimeoutMs: number;
}

export type LoadCommand = { type: "start" } | { type: "measure" } | { type: "stop" };

export interface LoadWorkerResult {
  type: "result";
  /** Requests measured: completed in the window (throughput), scheduled in it (rate). */
  measured: number;
  /** Measured requests that got a response, whatever its status. */
  responses: number;
  latency: LatencyHistogramSnapshot;
  errors: ErrorGroup[];
}

export type LoadWorkerReply = { type: "ready" } | { type: "failed"; message: string } | LoadWorkerResult;

interface Failure {
  code: string;
  message: string;
  sample: string;
  /** A response arrived (a status mismatch), as opposed to a transport failure. */
  responded: boolean;
}

class LoadGenerator {
  private readonly agent: Agent;
  private readonly errors = new ErrorGroups();
  private readonly latency = new LatencyHistogram();
  private next: number;
  private measuring = false;
  private measureFrom = Infinity;
  private stopped = false;
  private measured = 0;
  private responses = 0;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly data: LoadWorkerData) {
    this.agent = new Agent({
      connections: data.connections,
      headersTimeout: data.requestTimeoutMs,
      bodyTimeout: data.requestTimeoutMs,
    });
    this.next = data.cycleOffset;
  }

  private pick(): PreparedRequest {
    const index = this.data.cycle[this.next % this.data.cycle.length];
    this.next++;
    return this.data.requests[index];
  }

  /** Sends one request; resolves with the failure to record, or undefined on success. Never rejects. */
  private async send(request: PreparedRequest): Promise<Failure | undefined> {
    let responded = false;
    try {
      const response = await this.agent.request({
        origin: new URL(request.url).origin,
        path: urlPath(request.url),
        method: request.method as Dispatcher.HttpMethod,
        headers: request.headers,
        body: request.body,
      });
      responded = true;
      const status = response.statusCode;
      const accepted =
        request.expectStatus === undefined ? status >= 200 && status < 300 : status === request.expectStatus;
      if (accepted) {
        await response.body.dump();
        return undefined;
      }
      const sample = truncate(await response.body.text(), MAX_SAMPLE_LENGTH);
      const expected = request.expectStatus === undefined ? "a 2xx status" : `status ${request.expectStatus}`;
      return { code: String(status), message: `expected ${expected}, got ${status}`, sample, responded };
    } catch (error) {
      const carried = error instanceof Error ? (error as Error & { code?: unknown }) : undefined;
      return {
        code: typeof carried?.code === "string" ? carried.code : (carried?.name ?? "Error"),
        message: carried?.message ?? String(error),
        sample: "",
        responded,
      };
    }
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  start(): void {
    if (this.data.mode === "throughput") {
      for (let i = 0; i < this.data.connections; i++) this.track(this.closedLoop());
    } else {
      this.track(this.openLoop());
    }
  }

  private async closedLoop(): Promise<void> {
    while (!this.stopped) {
      const failure = await this.send(this.pick());
      if (!this.measuring || this.stopped) continue;
      this.measured++;
      if (!failure || failure.responded) this.responses++;
      if (failure) this.errors.record(failure.code, failure.message, failure.sample);
    }
  }

  // Requests go out on a fixed schedule whatever the server does; latency counts from the
  // scheduled time, so a stall delays every request due during it.
  private async openLoop(): Promise<void> {
    const interval = 1000 / this.data.rate;
    const origin = performance.now();
    let due = origin + this.data.phaseMs;
    while (!this.stopped) {
      const now = performance.now();
      while (due <= now && !this.stopped) {
        const scheduledAt = due;
        const counted = scheduledAt >= this.measureFrom;
        if (counted) this.measured++;
        this.track(
          this.send(this.pick()).then((failure) => {
            if (!counted) return;
            this.latency.recordMs(performance.now() - scheduledAt);
            if (!failure || failure.responded) this.responses++;
            if (failure) this.errors.record(failure.code, failure.message, failure.sample);
          }),
        );
        due += interval;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
    }
  }

  measure(): void {
    this.measuring = true;
    this.measureFrom = performance.now();
  }

  async stop(): Promise<LoadWorkerResult> {
    this.stopped = true;
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    await this.agent.close();
    return {
      type: "result",
      measured: this.measured,
      responses: this.responses,
      latency: this.latency.snapshot(),
      errors: this.errors.snapshot(),
    };
  }
}

function urlPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function serve(data: LoadWorkerData, port: MessagePort): void {
  const generator = new LoadGenerator(data);
  port.on("message", (command: LoadCommand) => {
    if (command.type === "start") generator.start();
    else if (command.type === "measure") generator.measure();
    else {
      generator.stop().then(
        (result) => port.postMessage(result),
        (error: unknown) =>
          port.postMessage({
            type: "failed",
            message: error instanceof Error ? (error.stack ?? error.message) : String(error),
          } satisfies LoadWorkerReply),
      );
    }
  });
  port.postMessage({ type: "ready" } satisfies LoadWorkerReply);
}

if (!isMainThread && (workerData as Partial<LoadWorkerData> | null)?.[LOAD_WORKER] === true) {
  serve(workerData as LoadWorkerData, parentPort!);
}
