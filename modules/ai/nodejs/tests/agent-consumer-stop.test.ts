import type { InvokeContext } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create as createAgentStream } from "../src/ai-agent-stream-controller.js";
import type { AgentStreamPart } from "../src/types.js";
import { ctx, provider, streamingModel, type Seen } from "./scripted-agents.js";

/** Resolves once `invokeCtx` is cancelled, rejecting as a cancelled call does. */
function untilCancelled(invokeCtx: InvokeContext | undefined): Promise<never> {
  return new Promise<never>((_, reject) =>
    invokeCtx!.cancellation.onCancelled(() =>
      reject(new InvokeError(ERR_INVOKE_CANCELLED, "cancelled")),
    ),
  );
}

async function readUntil(
  iterator: AsyncIterator<AgentStreamPart>,
  type: AgentStreamPart["type"],
): Promise<void> {
  while (true) {
    const step = await iterator.next();
    if (step.done) throw new Error(`the stream ended before a '${type}' part`);
    if (step.value.type === type) return;
  }
}

describe("a consumer that stops reading", () => {
  it("aborts the model call its pending read waits on, and makes no further one", async () => {
    const seen: Seen = { inputs: [] };
    const agent = await createAgentStream(
      { metadata: { name: "stream" }, model: streamingModel([{ answer: "partial" }], seen, 0) },
      ctx,
    );
    const { output } = await agent.invoke({ prompt: "go" });
    const iterator = output[Symbol.asyncIterator]();
    await readUntil(iterator, "text-delta");
    // The model now waits; the read stays pending while the consumer stops.
    const pending = iterator.next();
    pending.catch(() => undefined);
    await expect(iterator.return!()).resolves.toMatchObject({ done: true });
    await expect(pending).rejects.toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(seen.inputs).toHaveLength(1);
  });

  it("cancels the tool its pending read waits on, and calls the model no more", async () => {
    const seen: Seen = { inputs: [] };
    let toolCancelled = false;
    const tools = provider(async (_args, invokeCtx) => {
      try {
        return await untilCancelled(invokeCtx);
      } finally {
        toolCancelled = invokeCtx?.cancellation.isCancelled === true;
      }
    });
    const agent = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel([{ tools: [{ name: "work" }] }, { answer: "done" }], seen),
        toolProviders: [{ provider: tools }],
      },
      ctx,
    );
    const { output } = await agent.invoke({ prompt: "go" });
    const iterator = output[Symbol.asyncIterator]();
    await readUntil(iterator, "message");
    // The tool now runs; the read waits for its result.
    const pending = iterator.next();
    pending.catch(() => undefined);
    await expect(iterator.return!()).resolves.toMatchObject({ done: true });
    await pending.catch(() => undefined);
    expect(toolCancelled).toBe(true);
    expect(seen.inputs).toHaveLength(1);
  });
});
