import { ERR_INVOKE_CANCELLED, InvokeError, createCancellationSource } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { provider, runAgents, type CallPlan } from "./scripted-agents.js";

const replyWithBlock: CallPlan[] = [{ answer: "```telo-edit path=a\nx\n```\n" }, { answer: "done" }];

describe("a text call cancelled mid-call", () => {
  it("ends both agents with the cancellation, even under feedback", async () => {
    let source = createCancellationSource();
    const tool = provider(
      (_, invokeCtx) =>
        new Promise((_, reject) => {
          invokeCtx!.cancellation.onCancelled(() =>
            reject(new InvokeError(ERR_INVOKE_CANCELLED, "tool cancelled")),
          );
          source.cancel("turn cancelled");
        }),
    );
    const run = () =>
      runAgents({
        plans: replyWithBlock,
        toolProviders: [{ provider: tool }],
        config: {
          onToolError: "feedback",
          // A mapping is a function of its scope in these tests, standing in for CEL.
          textTools: [
            {
              tags: ["telo-edit"],
              tool: "work",
              arguments: (scope: { blocks: Array<{ body: string }> }) => ({
                bodies: scope.blocks.map((b) => b.body),
              }),
            },
          ],
        },
        invokeCtx: source.context,
      });
    const { buffered } = await run();
    source = createCancellationSource();
    const { streamed } = await run();
    expect(buffered.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(streamed.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(streamed.parts.some((p) => p.type === "tool-result")).toBe(false);
  });
});
