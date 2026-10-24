import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { AppRunRefused, type AppRun } from "../backend.js";
import {
  SupervisorClient,
  SupervisorRunFailed,
  SupervisorTerminated,
  type SupervisorListener,
  type SupervisorTermination,
} from "./supervisor-client.js";
import { SUPERVISOR_CLOSE } from "./supervisor-protocol.js";
import {
  startSupervisor,
  supervisorBinary,
  supervisorUnavailable,
  type RunningSupervisor,
} from "../test-support/supervisor-binary.js";

type Event =
  | { type: "connected"; state: string }
  | { type: "started"; runId: string }
  | { type: "exited"; runId: string; code?: number; signal?: string }
  | { type: "failed"; runId: string }
  | { type: "refused"; runId: string; code: string }
  | { type: "output"; text: string; stream: string; seq: number }
  | { type: "gap" }
  | { type: "disconnected" }
  | { type: "terminated"; termination: SupervisorTermination };

class RecordingListener implements SupervisorListener {
  readonly events: Event[] = [];
  private waiters: Array<() => void> = [];

  private push(event: Event): void {
    this.events.push(event);
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  onConnected(hello: { state: string }): void {
    this.push({ type: "connected", state: hello.state });
  }
  onStarted(runId: string): void {
    this.push({ type: "started", runId });
  }
  onExited(ending: { runId: string; code?: number; signal?: string }): void {
    this.push({ type: "exited", ...ending });
  }
  onFailed(runId: string): void {
    this.push({ type: "failed", runId });
  }
  onRefused(runId: string, code: string): void {
    this.push({ type: "refused", runId, code });
  }
  onOutput(chunk: Buffer, stream: string, seq: number): void {
    this.push({ type: "output", text: chunk.toString("utf8"), stream, seq });
  }
  onGap(): void {
    this.push({ type: "gap" });
  }
  onDisconnected(): void {
    this.push({ type: "disconnected" });
  }
  onTerminated(termination: SupervisorTermination): void {
    this.push({ type: "terminated", termination });
  }

  output(stream = "stdout"): string {
    return this.events
      .flatMap((event) => (event.type === "output" && event.stream === stream ? [event.text] : []))
      .join("");
  }

  of<T extends Event["type"]>(type: T): Array<Extract<Event, { type: T }>> {
    return this.events.filter((event): event is Extract<Event, { type: T }> => event.type === type);
  }

  async until(condition: () => boolean, what: string, withinMs = 5_000): Promise<void> {
    const deadline = Date.now() + withinMs;
    while (!condition()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${what} never happened: ${JSON.stringify(this.events)}`);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }
}

/** A TCP relay in front of a supervisor, to drop a connection or move the
 *  address to another supervisor, as a restarted container would. */
class Relay {
  private readonly sockets = new Set<Socket>();
  private refusing = false;
  private constructor(
    private readonly server: Server,
    readonly port: number,
    private target: number,
  ) {}

  static async start(target: number): Promise<Relay> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const relay = new Relay(server, (server.address() as { port: number }).port, target);
    server.on("connection", (inbound) => relay.relay(inbound));
    return relay;
  }

  private relay(inbound: Socket): void {
    if (this.refusing) return void inbound.destroy();
    const outbound = connectTcp(this.target, "127.0.0.1");
    for (const socket of [inbound, outbound]) {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => (socket === inbound ? outbound : inbound).destroy());
    }
    inbound.pipe(outbound).pipe(inbound);
  }

  /** Drops every relayed connection; with `refuse`, every new one too. */
  cut(refuse: boolean): void {
    this.refusing = refuse;
    for (const socket of this.sockets) socket.destroy();
  }

  resume(target = this.target): void {
    this.target = target;
    this.refusing = false;
  }

  close(): Promise<void> {
    this.cut(true);
    return new Promise((done) => this.server.close(() => done()));
  }
}

function run(runId: string, script: string): AppRun {
  return { runId, argv: ["sh", "-c", script], env: {}, cwd: ".", io: "streams" };
}

const unavailable = supervisorUnavailable();
const FAST_RECONNECT = { initial: 50, max: 200 };

describe.skipIf(unavailable !== undefined)("SupervisorClient against the supervisor", () => {
  let binary: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    binary = supervisorBinary();
  }, 600_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function supervisor(token?: string): Promise<RunningSupervisor> {
    const started = await startSupervisor(binary, {}, token);
    cleanups.push(() => started.stop());
    return started;
  }

  function client(port: number, token: string, listener: SupervisorListener): SupervisorClient {
    const created = new SupervisorClient({ host: "127.0.0.1", port, token, listener, reconnectDelayMs: FAST_RECONNECT });
    cleanups.push(() => created.close());
    return created;
  }

  it("runs, passes stdin to the live run, and reports its output and ending", async () => {
    const target = await supervisor();
    const listener = new RecordingListener();
    const supervised = client(target.port, target.token, listener);
    expect((await supervised.connect()).state).toBe("idle");

    await supervised.run(run("r1", "read line; printf \"got:$line\"; printf err >&2; exit 3"));
    supervised.writeStdin("r1", Buffer.from("abc\n"));
    await listener.until(() => listener.of("exited").length === 1, "the ending");

    expect(listener.output()).toBe("got:abc");
    expect(listener.output("stderr")).toBe("err");
    expect(listener.of("started")).toEqual([{ type: "started", runId: "r1" }]);
    expect(listener.of("exited")).toEqual([{ type: "exited", runId: "r1", code: 3 }]);
    expect(supervised.liveRunId).toBeUndefined();
  });

  it("refuses a second run while one is live, and stops the live one", async () => {
    const target = await supervisor();
    const listener = new RecordingListener();
    const supervised = client(target.port, target.token, listener);
    await supervised.connect();
    await supervised.run(run("r1", "read line"));

    await expect(supervised.run(run("r2", "exit 0"))).rejects.toBeInstanceOf(AppRunRefused);
    await supervised.stop("r1", 5_000);
    await listener.until(() => listener.of("exited").length === 1, "the ending");
    expect(listener.of("exited")).toEqual([{ type: "exited", runId: "r1", signal: "SIGTERM" }]);
  });

  it("rejects a run whose spawn never ran", async () => {
    const target = await supervisor();
    const listener = new RecordingListener();
    const supervised = client(target.port, target.token, listener);
    await supervised.connect();

    const failed = supervised.run({ runId: "r1", argv: ["/nonexistent/telo"], env: {}, cwd: ".", io: "streams" });
    await expect(failed).rejects.toBeInstanceOf(SupervisorRunFailed);
    expect(listener.of("failed")).toEqual([{ type: "failed", runId: "r1" }]);
  });

  it("terminates on a refused token", async () => {
    const target = await supervisor();
    const listener = new RecordingListener();
    const supervised = client(target.port, `${target.token}-not`, listener);

    const refused = await supervised.connect().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SupervisorTerminated);
    expect((refused as SupervisorTerminated).termination).toMatchObject({
      kind: "unauthorized",
      code: SUPERVISOR_CLOSE.tokenInvalid,
    });
  });

  it("terminates a connection another one superseded", async () => {
    const target = await supervisor();
    const first = new RecordingListener();
    const second = new RecordingListener();
    await client(target.port, target.token, first).connect();
    await client(target.port, target.token, second).connect();

    await first.until(() => first.of("terminated").length === 1, "the termination");
    expect(first.of("terminated")[0]!.termination.kind).toBe("superseded");
    expect(second.of("terminated")).toEqual([]);
  });

  it("reconnects after a drop, is replayed from its last seq, and learns an ending it missed", async () => {
    const target = await supervisor();
    const relay = await Relay.start(target.port);
    cleanups.push(() => relay.close());
    const listener = new RecordingListener();
    const supervised = client(relay.port, target.token, listener);
    await supervised.connect();
    await supervised.run(run("r1", "printf one; sleep 0.5; printf two; exit 4"));
    await listener.until(() => listener.output() === "one", "the first output");

    relay.cut(true);
    await listener.until(() => listener.of("disconnected").length >= 1, "the drop");
    await new Promise((done) => setTimeout(done, 1_000));
    relay.resume();
    await listener.until(() => listener.of("exited").length === 1, "the missed ending");

    expect(listener.output()).toBe("onetwo");
    expect(listener.of("output").map((event) => event.seq)).toEqual([1, 2]);
    expect(listener.of("gap")).toEqual([]);
    expect(listener.of("connected").map((event) => event.state)).toEqual(["idle", "idle"]);
    expect(listener.of("exited")).toEqual([{ type: "exited", runId: "r1", code: 4 }]);
    expect(listener.of("terminated")).toEqual([]);
  });

  it("terminates when another supervisor process answers at the address", async () => {
    const first = await supervisor("shared-token");
    const second = await supervisor("shared-token");
    const relay = await Relay.start(first.port);
    cleanups.push(() => relay.close());
    const listener = new RecordingListener();
    const supervised = client(relay.port, "shared-token", listener);
    await supervised.connect();

    relay.cut(true);
    relay.resume(second.port);
    await listener.until(() => listener.of("terminated").length === 1, "the termination");
    expect(listener.of("terminated")[0]!.termination.kind).toBe("restarted");
  });
});

if (unavailable !== undefined) {
  describe("SupervisorClient against the supervisor", () => {
    it.skip(`skipped: ${unavailable}`, () => {});
  });
}

describe("SupervisorClient generation check", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  // The supervisor of another generation cannot be built from this tree, so a
  // stand-in answers as one would.
  it("terminates on a supervisor hello of another generation, closing 4426", async () => {
    const closed = new Promise<number>((resolveClose) => {
      server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => undefined);
      server.on("connection", (socket) => {
        socket.once("message", () =>
          socket.send(JSON.stringify({ type: "hello", generation: 2, instance: "x", state: "idle" })),
        );
        socket.once("close", (code) => resolveClose(code));
      });
    });
    await new Promise<void>((done) => server!.once("listening", () => done()));
    const listener = new RecordingListener();
    const supervised = new SupervisorClient({
      host: "127.0.0.1",
      port: (server!.address() as { port: number }).port,
      token: "t",
      listener,
    });

    const refused = await supervised.connect().catch((error: unknown) => error);
    expect((refused as SupervisorTerminated).termination.kind).toBe("generation_mismatch");
    expect(await closed).toBe(SUPERVISOR_CLOSE.generationMismatch);
    await supervised.close();
  });
});
