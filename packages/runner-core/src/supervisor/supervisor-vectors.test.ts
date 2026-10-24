import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ByteStreamTag } from "../contract.js";
import {
  SUPERVISOR_CLOSE,
  SupervisorGenerationMismatch,
  SupervisorProtocolError,
  decodeOutputFrame,
  decodeSupervisorMessage,
  encodeRunnerMessage,
  type RunnerMessage,
} from "./supervisor-protocol.js";
import {
  startSupervisor,
  supervisorBinary,
  supervisorUnavailable,
  type RunningSupervisor,
} from "../test-support/supervisor-binary.js";
import { runExchange, supervisorVectors as vectors, type ExchangeVectors } from "../test-support/supervisor-exchange.js";

interface MessageVectors {
  runner: { valid: Array<{ name: string; message: RunnerMessage }> };
  supervisor: {
    valid: Array<{ name: string; message: unknown }>;
    invalid: Array<{ name: string; text: string; close: number }>;
  };
}

interface FrameVectors {
  valid: Array<{ name: string; seq: number; stream: ByteStreamTag; payloadHex: string; frameHex: string }>;
  invalid: Array<{ name: string; frameHex: string }>;
}

const messages = vectors<MessageVectors>("messages.json");
const frames = vectors<FrameVectors>("output-frames.json");

describe("supervisor message vectors", () => {
  it.each(messages.runner.valid)("encodes the runner's $name", ({ message }) => {
    expect(JSON.parse(encodeRunnerMessage(message))).toEqual(message);
  });

  it.each(messages.supervisor.valid)("decodes the supervisor's $name", ({ message }) => {
    expect(decodeSupervisorMessage(JSON.stringify(message))).toEqual(message);
  });

  // The runner closes `4426` on a generation mismatch and `4400` on anything
  // else malformed, as the client does.
  it.each(messages.supervisor.invalid)("refuses the supervisor's $name", ({ text, close }) => {
    expect(() => decodeSupervisorMessage(text)).toThrow(
      close === SUPERVISOR_CLOSE.generationMismatch ? SupervisorGenerationMismatch : SupervisorProtocolError,
    );
  });

  it.each(frames.valid)("decodes the output frame $name", ({ seq, stream, payloadHex, frameHex }) => {
    const frame = decodeOutputFrame(Buffer.from(frameHex, "hex"));
    expect({ seq: frame.seq, stream: frame.stream, payload: frame.payload.toString("hex") }).toEqual({
      seq,
      stream,
      payload: payloadHex,
    });
  });

  it.each(frames.invalid)("refuses the output frame $name", ({ frameHex }) => {
    expect(() => decodeOutputFrame(Buffer.from(frameHex, "hex"))).toThrow(SupervisorProtocolError);
  });
});

const exchanges = vectors<ExchangeVectors>("exchanges.json");
const unavailable = supervisorUnavailable();

describe.skipIf(unavailable !== undefined)("supervisor exchange vectors", () => {
  let binary: string;
  let supervisor: RunningSupervisor | undefined;

  beforeAll(() => {
    binary = supervisorBinary();
  }, 600_000);

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = undefined;
  });

  it.each(exchanges.exchanges)("$name", async ({ steps }) => {
    supervisor = await startSupervisor(binary, exchanges.workspace, "vector-token");
    const running = supervisor;
    try {
      await runExchange({ ...running, process: running.child }, steps);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- supervisor log ---\n${running.log()}`);
    }
  }, 30_000);
});

if (unavailable !== undefined) {
  describe("supervisor exchange vectors", () => {
    it.skip(`skipped: ${unavailable}`, () => {});
  });
}
