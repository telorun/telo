import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppState, ByteStreamTag } from "../contract.js";
import { FakeSupervisor } from "./fake-supervisor.js";
import { SupervisedApp, isGenerationMismatch } from "./supervised-app.js";
import { SUPERVISOR_GENERATION } from "./supervisor-protocol.js";

const TOKEN = "app-token";
const LABEL = "container 'app-web'";
const RUN = { runId: "run-1", argv: ["telo", "run", "telo.yaml"], env: {}, cwd: ".", io: "tty" as const };

let fake: FakeSupervisor | undefined;
let app: SupervisedApp | undefined;
let silent: Server | undefined;
const held: Socket[] = [];

afterEach(async () => {
  await app?.close();
  await fake?.close();
  for (const socket of held.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (silent ? silent.close(() => resolve()) : resolve()));
  app = fake = silent = undefined;
});

async function supervised(options: { generation?: number; live?: string } = {}) {
  fake = await FakeSupervisor.start({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    generation: options.generation ?? SUPERVISOR_GENERATION,
    live: options.live,
  });
  const states: AppState[] = [];
  const output: Array<{ text: string; stream: ByteStreamTag }> = [];
  app = new SupervisedApp(
    { host: "127.0.0.1", port: fake.port, token: TOKEN, label: LABEL },
    {
      onAppState: (state) => states.push(state),
      onOutput: (chunk, stream) => output.push({ text: chunk.toString(), stream }),
      onTerminated: () => {},
    },
  );
  return { fake, app, states, output };
}

describe("an app's state in /v1 terms", () => {
  it("says nothing until reporting starts, then the state as it stands: an adopted live run is running", async () => {
    const { app, states } = await supervised({ live: "run-0" });
    await app.connect(5_000);
    expect(states).toEqual([]);
    app.report();
    expect(states).toEqual([{ state: "running", runId: "run-0" }]);
  });

  it("reports a started run as running", async () => {
    const { app, states } = await supervised();
    await app.connect(5_000);
    app.report();
    await app.run(RUN);
    expect(states).toEqual([{ state: "ready" }, { state: "running", runId: "run-1" }]);
  });

  it("reports an exited run as ready with its ending", async () => {
    const { fake, app, states } = await supervised();
    await app.connect(5_000);
    app.report();
    await app.run(RUN);
    fake.end({ code: 3 });
    await expect.poll(() => states.at(-1)).toEqual({ state: "ready", ended: { runId: "run-1", code: 3 } });
  });

  it("reports a failed spawn as ready with its reason", async () => {
    const { fake, app, states } = await supervised({ live: "run-1" });
    await app.connect(5_000);
    app.report();
    fake.end({ failed: "no such program" });
    await expect.poll(() => states.at(-1)).toEqual({ state: "ready", ended: { runId: "run-1", reason: "no such program" } });
  });
});

describe("the app's output", () => {
  it("says on the app's output how many frames were lost before the runner read them", async () => {
    const { fake, app, output } = await supervised({ live: "run-1" });
    await app.connect(5_000);
    fake.output("tty", "a");
    await expect.poll(() => output.length).toBe(1);
    fake.drop();
    fake.output("tty", "b");
    fake.output("tty", "c");
    fake.forgetOutput();
    fake.output("tty", "d");
    await expect.poll(() => output.length, { timeout: 5_000 }).toBe(3);
    expect(output).toEqual([
      { text: "a", stream: "tty" },
      { text: "\r\n[runner] 2 output frame(s) were lost before the runner read them\r\n", stream: "tty" },
      { text: "d", stream: "tty" },
    ]);
  });
});

describe("connecting", () => {
  it("is refused as a generation mismatch when the supervisor speaks another generation", async () => {
    const { app } = await supervised({ generation: SUPERVISOR_GENERATION + 1 });
    const failure = await app.connect(5_000).catch((err: unknown) => err);
    expect(isGenerationMismatch(failure)).toBe(true);
  });

  it("names the label it was given when the supervisor never answers", async () => {
    silent = createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => silent!.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as { port: number }).port;
    app = new SupervisedApp(
      { host: "127.0.0.1", port, token: TOKEN, label: LABEL },
      { onAppState: () => {}, onOutput: () => {}, onTerminated: () => {} },
    );
    await expect(app.connect(200)).rejects.toThrow(
      "the session supervisor of container 'app-web' did not answer within 0.2s",
    );
  });
});
