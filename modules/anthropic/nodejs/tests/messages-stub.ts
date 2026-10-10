import { vi } from "vitest";
import type { AiModelInstance } from "@telorun/ai";
import type { InvokeContext } from "@telorun/sdk";

import * as messages from "../src/messages-controller.js";

// The stub is the injected `Http.Request`: it records the request the
// controller built, so "nothing was sent" is an assertion about the stub.

export const ANSWER = {
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

export type Invoke = (input: Record<string, unknown>, ctx?: InvokeContext) => Promise<unknown>;

/** A model over a request answering 200 with `answer`. */
export async function stubbed(answer: unknown = ANSWER, config: Record<string, unknown> = {}) {
  return over(async () => ({ status: 200, headers: {}, body: JSON.stringify(answer) }), config);
}

/** A model over the given request behaviour. */
export async function over(behaviour: Invoke, config: Record<string, unknown> = {}) {
  const invoke = vi.fn(behaviour);
  const model: AiModelInstance = await messages.create(
    {
      metadata: { name: "T", module: "App" },
      model: "claude-test",
      maxTokens: 1024,
      request: { invoke },
      ...config,
    } as never,
    {} as never,
  );
  return {
    invoke,
    model,
    /** The body of the request the controller last made. */
    body(): Record<string, any> {
      const call = invoke.mock.calls.at(-1);
      if (!call) throw new Error("the request was not invoked");
      return (call[0] as { body: Record<string, any> }).body;
    },
  };
}

/** What a call ends in: its answer, or the error it raised. */
export async function outcome(
  model: AiModelInstance,
  input: Record<string, unknown>,
  ctx?: InvokeContext,
): Promise<any> {
  try {
    return await model.invoke(input as never, ctx);
  } catch (err) {
    return err;
  }
}
