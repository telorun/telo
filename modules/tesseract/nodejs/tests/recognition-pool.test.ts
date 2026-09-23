import { createCancellationSource, InvokeError, NEVER_CANCELLED } from "@telorun/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineLostError, RecognitionPool, type PoolEngine } from "../src/recognition-pool.js";

/** An engine whose jobs finish only when the test says so. */
class FakeEngine implements PoolEngine<string, string> {
  readonly jobs: { job: string; finish: (result: string) => void; lose: (cause: string) => void }[] = [];
  terminated = false;
  private lostListener: ((cause: Error) => void) | undefined;

  run(job: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.jobs.push({ job, finish: resolve, lose: (cause) => reject(new EngineLostError(cause)) });
    });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    for (const job of this.jobs) job.lose("terminated");
  }

  onLost(listener: (cause: Error) => void): void {
    this.lostListener = listener;
  }

  /** The worker dies on its own. */
  crash(cause: string): void {
    for (const job of this.jobs) job.lose(cause);
    this.lostListener?.(new Error(cause));
  }
}

const log = { warn: vi.fn(), error: vi.fn() };
const fail = (code: string, message: string) => new InvokeError(code, message);

function pool(options: { size?: number; queueLimit?: number; maxRunMs?: number; start?: () => Promise<FakeEngine> }) {
  const engines: FakeEngine[] = [];
  const startEngine =
    options.start ??
    (async () => {
      const engine = new FakeEngine();
      engines.push(engine);
      return engine;
    });
  const instance = new RecognitionPool<string, string>({
    size: options.size ?? 1,
    queueLimit: options.queueLimit ?? 10,
    maxRunMs: options.maxRunMs ?? 60_000,
    startEngine,
    fail,
    log,
  });
  return { pool: instance, engines };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code,
  );

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  log.warn.mockClear();
  log.error.mockClear();
});

describe("RecognitionPool", () => {
  it("refuses a call beyond the running ones plus queueLimit", async () => {
    const { pool: p, engines } = pool({ size: 2, queueLimit: 1 });
    await p.start();
    const running = [p.submit("a", NEVER_CANCELLED), p.submit("b", NEVER_CANCELLED)];
    const queued = p.submit("c", NEVER_CANCELLED);
    expect(await code(p.submit("d", NEVER_CANCELLED))).toBe("ERR_OCR_OVERLOADED");

    for (const engine of engines) engine.jobs[0]!.finish("done");
    await Promise.all(running);
    await tick();
    const engine = engines.find((e) => e.jobs.length === 2)!;
    expect(engine.jobs[1]!.job).toBe("c");
    engine.jobs[1]!.finish("done");
    expect(await queued).toBe("done");
  });

  it("drops a call cancelled while queued without touching any engine", async () => {
    const { pool: p, engines } = pool({ size: 1 });
    await p.start();
    const running = p.submit("a", NEVER_CANCELLED);
    const source = createCancellationSource();
    const queued = p.submit("b", source.token);
    source.cancel("caller gave up");

    expect(await code(queued)).toBe("ERR_INVOKE_CANCELLED");
    engines[0]!.jobs[0]!.finish("done");
    expect(await running).toBe("done");
    await tick();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.jobs).toHaveLength(1);
    expect(engines[0]!.terminated).toBe(false);
  });

  it("stops and replaces the engine of a call cancelled while running", async () => {
    const { pool: p, engines } = pool({ size: 1 });
    await p.start();
    const source = createCancellationSource();
    const call = p.submit("a", source.token);
    source.cancel("deadline-exceeded");

    expect(await code(call)).toBe("ERR_INVOKE_CANCELLED");
    await tick();
    expect(engines[0]!.terminated).toBe(true);
    expect(engines).toHaveLength(2);
    const next = p.submit("b", NEVER_CANCELLED);
    engines[1]!.jobs[0]!.finish("fresh");
    expect(await next).toBe("fresh");
  });

  it("fails a recognition past maxRunMs, counting from when it started rather than from the queue", async () => {
    vi.useFakeTimers();
    const { pool: p, engines } = pool({ size: 1, maxRunMs: 100 });
    await p.start();
    const first = p.submit("a", NEVER_CANCELLED);
    const second = code(p.submit("b", NEVER_CANCELLED));

    await vi.advanceTimersByTimeAsync(90);
    engines[0]!.jobs[0]!.finish("done");
    expect(await first).toBe("done");

    // `b` has waited 90ms in the queue; it has run for 90ms of its own here.
    await vi.advanceTimersByTimeAsync(90);
    expect(engines[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await second).toBe("ERR_OCR_LIMIT_EXCEEDED");
    expect(engines[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(engines).toHaveLength(2);
  });

  it("fails the call of an engine that crashes and replaces it", async () => {
    const { pool: p, engines } = pool({ size: 1 });
    await p.start();
    const call = p.submit("a", NEVER_CANCELLED);
    engines[0]!.crash("worker aborted");

    await expect(call).rejects.toMatchObject({
      code: "ERR_OCR_ENGINE_FAILED",
      message: expect.stringContaining("worker aborted"),
    });
    await tick();
    expect(engines).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith("Replacing an engine", { reason: "worker aborted" });
    const next = p.submit("b", NEVER_CANCELLED);
    engines[1]!.jobs[0]!.finish("fresh");
    expect(await next).toBe("fresh");
  });

  it("fails every call, naming the cause, once no engine is left and none can start", async () => {
    let started = 0;
    const engines: FakeEngine[] = [];
    const { pool: p } = pool({
      size: 1,
      start: async () => {
        if (started++ > 0) throw new Error("model file vanished");
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
    });
    await p.start();
    const running = p.submit("a", NEVER_CANCELLED);
    const queued = p.submit("b", NEVER_CANCELLED);
    engines[0]!.crash("worker aborted");

    expect(await code(running)).toBe("ERR_OCR_ENGINE_FAILED");
    await expect(queued).rejects.toMatchObject({
      code: "ERR_OCR_ENGINE_FAILED",
      message: expect.stringContaining("model file vanished"),
    });
    expect(log.error).toHaveBeenCalledWith("A replacement engine could not start", {
      "error.message": "model file vanished",
    });
    await expect(p.submit("c", NEVER_CANCELLED)).rejects.toMatchObject({
      code: "ERR_OCR_ENGINE_FAILED",
      message: expect.stringContaining("model file vanished"),
    });
  });

  it("recovers on the next call once an engine can start again", async () => {
    let failing = false;
    const engines: FakeEngine[] = [];
    const { pool: p } = pool({
      size: 1,
      start: async () => {
        if (failing) throw new Error("transient");
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
    });
    await p.start();
    const call = p.submit("a", NEVER_CANCELLED);
    failing = true;
    engines[0]!.crash("worker aborted");
    expect(await code(call)).toBe("ERR_OCR_ENGINE_FAILED");
    await tick();

    failing = false;
    const next = p.submit("b", NEVER_CANCELLED);
    await tick();
    expect(engines).toHaveLength(2);
    engines[1]!.jobs[0]!.finish("fresh");
    expect(await next).toBe("fresh");
  });

  it("waits for an engine still starting when torn down, and stops it", async () => {
    let release: (() => void) | undefined;
    const engines: FakeEngine[] = [];
    let first = true;
    const { pool: p } = pool({
      size: 1,
      start: async () => {
        if (!first) await new Promise<void>((resolve) => (release = resolve));
        first = false;
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
    });
    await p.start();
    engines[0]!.crash("worker aborted");
    await tick();
    let closed = false;
    const closing = p.close().then(() => (closed = true));
    await tick();
    expect(closed).toBe(false);
    release!();
    await closing;
    expect(engines[1]!.terminated).toBe(true);
  });

  it("fails a call that races teardown with a code the contract declares", async () => {
    const { pool: p } = pool({ size: 1 });
    await p.start();
    const running = p.submit("a", NEVER_CANCELLED);
    await p.close();
    expect(await code(running)).toBe("ERR_OCR_ENGINE_FAILED");
    expect(await code(p.submit("b", NEVER_CANCELLED))).toBe("ERR_OCR_ENGINE_FAILED");
  });
});
