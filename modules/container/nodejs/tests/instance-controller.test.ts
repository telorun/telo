import {
  NOOP_LOGGER,
  RuntimeError,
  celDurationFromNanos,
  type Inverse,
  type ResourceContext,
} from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import type {
  ContainerEngine,
  ContainerReadiness,
  ContainerState,
  ContainerSummary,
  PortBinding,
} from "../src/container-engine-contract.js";
import { ContainerInstance, EXPIRES_LABEL } from "../src/instance-controller.js";
import { LogReady } from "../src/log-ready-controller.js";

const ctx = {
  log: NOOP_LOGGER,
  resolveRef(value: unknown, guard: (candidate: unknown) => boolean, describe: () => string) {
    if (!guard(value)) throw new Error(`${describe()} is not resolvable`);
    return value;
  },
} as unknown as ResourceContext;

const seconds = (n: number) => celDurationFromNanos(BigInt(n) * 1_000_000_000n);

/** An engine answering from memory, recording what was removed. */
class FakeEngine implements ContainerEngine {
  removed: string[] = [];
  listed: ContainerSummary[] = [];
  state: ContainerState = { running: true, exitCode: null, bindings: new Map() };
  output: string[] = [];
  async ping() {}
  async hasImage() {
    return true;
  }
  async pullImage() {}
  async create() {
    return "c1";
  }
  async start() {}
  async inspect() {
    return this.state;
  }
  async *logs(): AsyncIterable<string> {
    yield* this.output;
  }
  async list() {
    return this.listed;
  }
  async remove(id: string) {
    this.removed.push(id);
  }
}

function instance(engine: ContainerEngine, extra: Record<string, unknown> = {}) {
  return new ContainerInstance(
    {
      metadata: { name: "db" },
      engine,
      image: "postgres:18",
      ports: [5432],
      lifetime: seconds(600),
      ...extra,
    } as never,
    ctx,
  );
}

/** Runs the start the way the kernel runs an effect body: each yielded
 *  inverse is kept, and on failure they unwind newest-first. */
async function start(target: ContainerInstance): Promise<void> {
  const inverses: Inverse[] = [];
  const body = target.start();
  try {
    for (let step = await body.next(); !step.done; step = await body.next()) {
      inverses.push(step.value);
    }
  } catch (err) {
    for (const inverse of inverses.reverse()) await inverse();
    throw err;
  }
}

async function failure(promise: Promise<unknown>): Promise<RuntimeError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RuntimeError);
  return err as RuntimeError;
}

const bound = (binding: PortBinding) => new Map([[5432, binding]]);

describe("Container.Instance", () => {
  it("publishes the binding the engine reports", async () => {
    const engine = new FakeEngine();
    engine.state = { running: true, exitCode: null, bindings: bound({ host: "10.1.2.3", port: 5432 }) };
    const db = instance(engine);
    await start(db);
    expect(db.binding(5432)).toEqual({ host: "10.1.2.3", port: 5432 });
  });

  it("fails the start when the engine reports no binding, and removes the container", async () => {
    const engine = new FakeEngine();
    const err = await failure(start(instance(engine)));
    expect(err.code).toBe("ERR_CONTAINER_START_FAILED");
    expect(err.message).toContain('Container.Instance "db"');
    expect(err.message).toContain("no binding for port 5432/tcp");
    expect(engine.removed).toEqual(["c1"]);
  });

  it.each(["0.0.0.0", "::"])("fails the start on the unspecified address %s", async (host) => {
    const engine = new FakeEngine();
    engine.state = { running: true, exitCode: null, bindings: bound({ host, port: 49200 }) };
    const err = await failure(start(instance(engine)));
    expect(err.code).toBe("ERR_CONTAINER_START_FAILED");
    expect(err.message).toContain(`unspecified address '${host}' for port 5432/tcp`);
    expect(engine.removed).toEqual(["c1"]);
  });

  it("reports an exit before readiness with its code and output", async () => {
    const engine = new FakeEngine();
    engine.state = { running: false, exitCode: 3, bindings: new Map() };
    engine.output = ["initdb: error\n"];
    const readiness = new LogReady({ metadata: { name: "r" }, text: "ready" });
    const err = await failure(start(instance(engine, { readiness })));
    expect(err.code).toBe("ERR_CONTAINER_EXITED");
    expect(err.message).toContain("exited with code 3 before it was ready");
    expect(err.message).toContain("initdb: error");
    expect(engine.removed).toEqual(["c1"]);
  });

  describe("when the exit's output cannot be read", () => {
    /** An engine whose follow stream ends at once and whose tail request
     *  fails as `tail` says. */
    class TailEngine extends FakeEngine {
      constructor(private readonly tail: (signal?: AbortSignal) => Promise<never>) {
        super();
        this.state = { running: false, exitCode: 3, bindings: new Map() };
      }
      async *logs(id?: string, options?: { follow: boolean }, signal?: AbortSignal): AsyncIterable<string> {
        if (!options?.follow) await this.tail(signal);
      }
    }
    const readiness = new LogReady({ metadata: { name: "r" }, text: "ready" });

    it("still reports the exit, stating why the output is missing", async () => {
      const engine = new TailEngine(async () => {
        throw new Error("socket hang up");
      });
      const err = await failure(start(instance(engine, { readiness })));
      expect(err.code).toBe("ERR_CONTAINER_EXITED");
      expect(err.message).toContain("exited with code 3 before it was ready");
      expect(err.message).toContain("Its output could not be read: socket hang up");
      expect(engine.removed).toEqual(["c1"]);
    });

    it("bounds the tail request by the startup timeout", async () => {
      const engine = new TailEngine(
        (signal) =>
          new Promise<never>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason)),
          ),
      );
      const err = await failure(
        start(instance(engine, { readiness, startupTimeout: celDurationFromNanos(20_000_000n) })),
      );
      expect(err.code).toBe("ERR_CONTAINER_EXITED");
      expect(err.message).toContain("Its output could not be read within 0.02s.");
      expect(engine.removed).toEqual(["c1"]);
    });
  });

  it("fails as not ready once the startup timeout passes", async () => {
    const engine = new FakeEngine();
    const never: ContainerReadiness = {
      waitUntilReady: (_target, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const err = await failure(
      start(instance(engine, { readiness: never, startupTimeout: celDurationFromNanos(20_000_000n) })),
    );
    expect(err.code).toBe("ERR_CONTAINER_NOT_READY");
    expect(err.message).toContain("was not ready within 0.02s");
    expect(engine.removed).toEqual(["c1"]);
  });

  it("removes only expired containers before starting", async () => {
    const engine = new FakeEngine();
    engine.state = { running: true, exitCode: null, bindings: bound({ host: "127.0.0.1", port: 1 }) };
    const now = Math.floor(Date.now() / 1000);
    engine.listed = [
      { id: "old", labels: { [EXPIRES_LABEL]: String(now - 10) } },
      { id: "live", labels: { [EXPIRES_LABEL]: String(now + 600) } },
    ];
    await start(instance(engine));
    expect(engine.removed).toEqual(["old"]);
  });
});

describe("Container.LogReady", () => {
  const target = (...chunks: string[]) => ({
    async *logs() {
      yield* chunks;
    },
  });
  const signal = new AbortController().signal;

  it("counts occurrences, one of them spanning two chunks", async () => {
    const ready = new LogReady({ metadata: { name: "r" }, text: "ready now", times: 2 });
    expect(await ready.waitUntilReady(target("x ready now y rea", "dy now"), signal)).toBe(true);
  });

  it("answers false when the output ends first", async () => {
    const ready = new LogReady({ metadata: { name: "r" }, text: "ready", times: 2 });
    expect(await ready.waitUntilReady(target("ready", "\n"), signal)).toBe(false);
  });
});
