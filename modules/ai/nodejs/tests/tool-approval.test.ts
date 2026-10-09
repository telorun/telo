import type { InvokeContext } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError, createCancellationSource } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create as createAgentStream } from "../src/ai-agent-stream-controller.js";
import { create as createTools } from "../src/ai-tools-controller.js";
import type { ToolProviderEntry } from "../src/agent-tools.js";
import type { AiToolProviderInstance, Message } from "../src/types.js";
import {
  ctx,
  drain,
  partsOf,
  runAgents,
  streamingModel,
  type AgentRun,
  type CallPlan,
} from "./scripted-agents.js";

/** A provider of the named tools that records which ran. It has no approval
 *  method of its own unless `extra` gives it one. */
function toolbox(names: string[], extra: Partial<AiToolProviderInstance> = {}) {
  const ran: string[] = [];
  const box: AiToolProviderInstance & { ran: string[] } = {
    ran,
    listTools: () => names.map((name) => ({ name, parameters: { type: "object" } })),
    callTool: async (name) => {
      ran.push(name);
      return `${name} ran`;
    },
    ...extra,
  };
  return box;
}

/** One response asking for `wipe` (c1) then `read` (c2), then an answer. */
const wipeThenRead: CallPlan[] = [
  {
    tools: [
      { name: "wipe", id: "c1" },
      { name: "read", id: "c2" },
    ],
  },
  { answer: "done" },
];

const wipeCall = { id: "c1", name: "wipe", arguments: {} };
const readCall = { id: "c2", name: "read", arguments: {} };
const user: Message = { role: "user", content: "go" };

/** Only `wipe` needs a decision. */
const gatedWipe = (box: AiToolProviderInstance): ToolProviderEntry[] => [
  { provider: box, approval: { include: ["wipe"] } },
];

/** An approver answering with `answer(toolCall)`, recording what it was asked. */
function approver(answer: (call: { id: string; name: string }) => unknown) {
  const asked: unknown[] = [];
  return {
    asked,
    config: {
      approver: {
        invoke: {
          invoke: async (inputs: { toolCall: { id: string; name: string } }) => {
            asked.push(inputs);
            return answer(inputs.toolCall);
          },
        },
        inputs: (scope: unknown) => scope,
        result: ({ result }: { result: unknown }) => result,
      },
    },
  };
}

/** Runs `wipeThenRead` to its interrupt and returns the conversation to resume. */
async function interruptedConversation(): Promise<Message[]> {
  const { buffered } = await runAgents({
    plans: wipeThenRead,
    toolProviders: gatedWipe(toolbox(["wipe", "read"])),
  });
  return [user, ...buffered.result!.messages];
}

const resume = (run: Omit<AgentRun, "plans">) => runAgents({ plans: [{ answer: "done" }], ...run });

describe("a tool call that needs a decision", () => {
  it("is not run: its siblings report, then the run ends asking", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, bufferedSeen, streamed, streamSeen } = await runAgents({
      plans: wipeThenRead,
      toolProviders: gatedWipe(box),
    });
    const assistant = { role: "assistant", content: "", toolCalls: [wipeCall, readCall] };
    const readMessage = { role: "tool", content: "read ran", toolCallId: "c2" };
    expect(streamed.error).toBeUndefined();
    expect(streamed.parts).toEqual([
      { type: "tool-call", toolCall: wipeCall },
      { type: "tool-call", toolCall: readCall },
      expect.objectContaining({ type: "step-finish" }),
      { type: "message", message: assistant },
      {
        type: "tool-result",
        toolResult: { toolCallId: "c2", name: "read", content: "read ran", output: "read ran" },
      },
      { type: "message", message: readMessage },
      { type: "tool-approval-request", toolCall: wipeCall },
      { type: "finish", usage: expect.anything(), finishReason: "tool-calls", interrupt: "approval" },
    ]);
    expect(buffered.result).toMatchObject({
      finishReason: "tool-calls",
      interrupt: "approval",
      approvalRequests: [wipeCall],
      messages: [assistant, readMessage],
    });
    expect(buffered.result!.steps).toEqual([{ text: "", toolCalls: [wipeCall, readCall] }]);
    expect(buffered.result!.toolResults).toEqual([
      { toolCallId: "c2", name: "read", content: "read ran" },
    ]);
    // No approver, so nothing was asked and nothing is reported as decided.
    expect(buffered.result).not.toHaveProperty("approvalDecisions");
    expect(box.ran).toEqual(["read", "read"]);
    expect([bufferedSeen.inputs.length, streamSeen.inputs.length]).toEqual([1, 1]);
  });

  it("is chosen by the entry's name lists, matched on bare names", async () => {
    const waitingFor = async (entry: Omit<ToolProviderEntry, "provider">, prefix = "") => {
      const { buffered, streamed } = await runAgents({
        plans: [
          {
            tools: [
              { name: `${prefix}wipe`, id: "c1" },
              { name: `${prefix}read`, id: "c2" },
            ],
          },
          { answer: "done" },
        ],
        // A provider with no approval method of its own.
        toolProviders: [{ provider: toolbox(["wipe", "read"]), ...entry }],
      });
      const requested = partsOf(streamed.parts, "tool-approval-request").map((p) => p.toolCall.name);
      expect(requested).toEqual((buffered.result!.approvalRequests ?? []).map((call) => call.name));
      return requested;
    };
    expect(await waitingFor({})).toEqual([]);
    expect(await waitingFor({ approval: {} })).toEqual(["wipe", "read"]);
    expect(await waitingFor({ approval: { include: [] } })).toEqual([]);
    expect(await waitingFor({ approval: { exclude: ["read", "not-a-tool"] } })).toEqual(["wipe"]);
    expect(await waitingFor({ approval: { include: ["wipe"] }, prefix: "fs_" }, "fs_")).toEqual([
      "fs_wipe",
    ]);
  });

  it("is chosen by its provider too, asked only where the lists did not gate", async () => {
    const judged: string[] = [];
    const box = toolbox(["wipe", "read", "send"], {
      toolRequiresApproval: (name, args, context) => {
        judged.push(name);
        return name === "send" && args.to === "everyone" && context?.tenant === "acme";
      },
    });
    const { buffered } = await runAgents({
      plans: [
        {
          tools: [
            { name: "wipe", id: "c1" },
            { name: "read", id: "c2" },
            { name: "send", id: "c3", args: { to: "everyone" } },
          ],
        },
        { answer: "done" },
      ],
      toolProviders: gatedWipe(box),
      inputs: { prompt: "go", context: { tenant: "acme" } },
    });
    expect(buffered.result!.approvalRequests!.map((call) => call.name)).toEqual(["wipe", "send"]);
    // Once per agent, and never for the call the lists had already gated.
    expect(judged).toEqual(["read", "send", "read", "send"]);
  });

  it("fails as that call does when its gate cannot be evaluated, without running the tool", async () => {
    const box = toolbox(["wipe"], {
      toolRequiresApproval: () => {
        throw new Error("no such argument");
      },
    });
    const plans: CallPlan[] = [{ tools: [{ name: "wipe", id: "c1" }] }, { answer: "done" }];
    const fedBack = await runAgents({ plans, toolProviders: [{ provider: box }] });
    const failure = { toolCallId: "c1", name: "wipe", content: "Error: no such argument", error: true };
    expect(fedBack.buffered.result!.toolResults).toEqual([failure]);
    expect(partsOf(fedBack.streamed.parts, "tool-result")[0]!.toolResult).toEqual(failure);

    const thrown = await runAgents({
      plans,
      toolProviders: [{ provider: box }],
      config: { onToolError: "throw" },
    });
    expect(thrown.buffered.error).toMatchObject({ message: "no such argument" });
    expect(thrown.streamed.error).toMatchObject({ message: "no such argument" });
    expect(box.ran).toEqual([]);
  });

  it("fails as that call does when its provider's answer is not a boolean, never reading it as ungated", async () => {
    const box = toolbox(["wipe"], { toolRequiresApproval: () => "yes" as unknown as boolean });
    const plans: CallPlan[] = [{ tools: [{ name: "wipe", id: "c1" }] }, { answer: "done" }];
    const fedBack = await runAgents({ plans, toolProviders: [{ provider: box }] });
    const failure = {
      toolCallId: "c1",
      name: "wipe",
      content: expect.stringContaining(`answered 'toolRequiresApproval' with "yes", not a boolean`),
      error: true,
    };
    expect(fedBack.buffered.result!.toolResults).toEqual([failure]);
    expect(partsOf(fedBack.streamed.parts, "tool-result")[0]!.toolResult).toEqual(failure);

    const thrown = await runAgents({
      plans,
      toolProviders: [{ provider: box }],
      config: { onToolError: "throw" },
    });
    expect(thrown.buffered.error).toMatchObject({ code: "ERR_CONTRACT_VIOLATION" });
    expect(thrown.streamed.error).toMatchObject({ code: "ERR_CONTRACT_VIOLATION" });
    expect(box.ran).toEqual([]);
  });

  it("refuses an approval.include name the entry does not expose", async () => {
    const { buffered, streamed } = await runAgents({
      plans: wipeThenRead,
      toolProviders: [{ provider: toolbox(["wipe", "read"]), approval: { include: ["erase"] } }],
    });
    expect(buffered.error).toMatchObject({ code: "ERR_AGENT_APPROVAL_UNKNOWN_TOOL" });
    expect(streamed.error).toMatchObject({ code: "ERR_AGENT_APPROVAL_UNKNOWN_TOOL" });
  });
});

describe("Ai.Tools' approval", () => {
  it("answers each call from the tool's own gate, false when it declares none", async () => {
    const tool = { invoke: async () => ({}) };
    const tools = await createTools(
      {
        metadata: { name: "tools" },
        tools: [
          { tool, name: "read", parameters: { type: "object" } },
          { tool, name: "wipe", parameters: { type: "object" }, approval: true },
          {
            tool,
            name: "pay",
            parameters: { type: "object" },
            approval: (scope: { arguments: { amount: number }; context: { limit: number } }) =>
              scope.arguments.amount > scope.context.limit,
          },
        ],
      },
      ctx,
    );
    expect([
      tools.toolRequiresApproval("read", {}),
      tools.toolRequiresApproval("wipe", {}),
      tools.toolRequiresApproval("pay", { amount: 50 }, { limit: 100 }),
      tools.toolRequiresApproval("pay", { amount: 500 }, { limit: 100 }),
    ]).toEqual([false, true, false, true]);
  });

  it("refuses a gate that does not evaluate to a boolean, naming the tool's approval", async () => {
    const tools = await createTools(
      {
        metadata: { name: "tools" },
        tools: [
          {
            tool: { invoke: async () => ({}) },
            name: "wipe",
            parameters: { type: "object" },
            approval: () => "true",
          },
        ],
      },
      ctx,
    );
    expect(() => tools.toolRequiresApproval("wipe", {})).toThrowError(
      expect.objectContaining({
        code: "ERR_PREDICATE_NOT_BOOLEAN",
        message: expect.stringContaining(`Ai.Tools "tools": tools[0].approval (tool "wipe")`),
      }),
    );
  });
});

describe("the record of a run", () => {
  it("is every appended message, the same from both agents, and resumes to the same request", async () => {
    const plans: CallPlan[] = [{ tools: [{ name: "read", id: "c2" }] }, { answer: "done" }];
    const whole = await runAgents({ plans, toolProviders: [{ provider: toolbox(["read"]) }] });
    const record = partsOf(whole.streamed.parts, "message").map((p) => p.message);
    expect(record).toEqual([
      { role: "assistant", content: "", toolCalls: [readCall] },
      { role: "tool", content: "read ran", toolCallId: "c2" },
      { role: "assistant", content: "done" },
    ]);
    expect(whole.buffered.result!.messages).toEqual(record);

    // The input followed by the parts emitted so far is the next request.
    const beforeAnswer = [user, ...record.slice(0, 2)];
    expect(whole.streamSeen.inputs[1]!.messages).toEqual(beforeAnswer);
    const resumed = await resume({
      toolProviders: [{ provider: toolbox(["read"]) }],
      inputs: { messages: beforeAnswer },
    });
    expect(resumed.streamSeen.inputs[0]).toEqual(whole.streamSeen.inputs[1]);
    expect(resumed.bufferedSeen.inputs[0]).toEqual(whole.bufferedSeen.inputs[1]);
  });

  it("holds the message of a tool that ran before the run was rejected", async () => {
    const box = toolbox(["read", "wipe"]);
    box.callTool = async (name) => {
      if (name === "wipe") throw new Error("disk full");
      return "read ran";
    };
    const { streamed } = await runAgents({
      plans: [
        {
          tools: [
            { name: "read", id: "c2" },
            { name: "wipe", id: "c1" },
          ],
        },
      ],
      toolProviders: [{ provider: box }],
      config: { onToolError: "throw", maxParallelTools: 1 },
    });
    expect(streamed.error).toMatchObject({ message: "disk full" });
    expect(partsOf(streamed.parts, "message").at(-1)!.message).toEqual({
      role: "tool",
      content: "read ran",
      toolCallId: "c2",
    });
  });
});

describe("resuming a run that ended asking", () => {
  it("runs an approved call and gives the model both results in call order", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, bufferedSeen, streamed, streamSeen } = await resume({
      toolProviders: gatedWipe(box),
      inputs: {
        messages: await interruptedConversation(),
        approvals: [{ toolCallId: "c1", approved: true }],
      },
    });
    const wipeMessage = { role: "tool", content: "wipe ran", toolCallId: "c1" };
    expect(streamed.parts.map((p) => p.type)).toEqual([
      "tool-result",
      "message",
      "text-delta",
      "step-finish",
      "message",
      "finish",
    ]);
    expect(buffered.result!.messages).toEqual([wipeMessage, { role: "assistant", content: "done" }]);
    expect(box.ran).toEqual(["wipe", "wipe"]);
    for (const seen of [bufferedSeen, streamSeen]) {
      const toolMessages = seen.inputs[0]!.messages.filter((m: Message) => m.role === "tool");
      expect(toolMessages.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    }
  });

  it("denies a refused call to the model without reaching the tool, whatever onToolError says", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, streamed, streamSeen } = await resume({
      toolProviders: gatedWipe(box),
      config: { onToolError: "throw" },
      inputs: {
        messages: await interruptedConversation(),
        approvals: [{ toolCallId: "c1", approved: false, reason: "too risky" }],
      },
    });
    const content = 'Denied: the call to "wipe" was not approved and did not run. Reason: too risky';
    const denied = { toolCallId: "c1", name: "wipe", content, denied: true };
    expect(partsOf(streamed.parts, "tool-result")[0]!.toolResult).toEqual(denied);
    expect(buffered.result!.toolResults).toEqual([denied]);
    // The resumed calls add no step: only this run's model call does.
    expect(buffered.result!.steps).toEqual([{ text: "done", toolCalls: [] }]);
    expect(streamSeen.inputs[0]!.messages[2]).toEqual({ role: "tool", content, toolCallId: "c1" });
    expect(box.ran).toEqual([]);
  });

  it("records an approved call that fails as an error result, in no step", async () => {
    const box = toolbox(["wipe", "read"], {
      callTool: async () => {
        throw new Error("disk full");
      },
    });
    const { buffered } = await resume({
      toolProviders: gatedWipe(box),
      inputs: {
        messages: await interruptedConversation(),
        approvals: [{ toolCallId: "c1", approved: true }],
      },
    });
    expect(buffered.result!.toolResults).toEqual([
      { toolCallId: "c1", name: "wipe", content: "Error: disk full", error: true },
    ]);
    expect(buffered.result!.steps).toEqual([{ text: "done", toolCalls: [] }]);
  });

  it("asks again, calling no model, when the pending call is given no decision", async () => {
    const { buffered, bufferedSeen, streamed, streamSeen } = await resume({
      toolProviders: gatedWipe(toolbox(["wipe", "read"])),
      inputs: { messages: await interruptedConversation() },
    });
    expect(streamed.parts).toEqual([
      { type: "tool-approval-request", toolCall: wipeCall },
      { type: "finish", usage: expect.anything(), finishReason: "tool-calls", interrupt: "approval" },
    ]);
    expect(buffered.result).toMatchObject({
      interrupt: "approval",
      approvalRequests: [wipeCall],
      messages: [],
      steps: [],
      toolResults: [],
    });
    expect([bufferedSeen.inputs.length, streamSeen.inputs.length]).toEqual([0, 0]);
  });

  it("runs a pending call that needs no decision and has no result yet", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, streamSeen } = await resume({
      toolProviders: gatedWipe(box),
      inputs: {
        messages: [user, { role: "assistant", content: "", toolCalls: [wipeCall, readCall] }],
        approvals: [{ toolCallId: "c1", approved: true }],
      },
    });
    expect(box.ran.sort()).toEqual(["read", "read", "wipe", "wipe"]);
    expect(buffered.result!.text).toBe("done");
    expect(streamSeen.inputs).toHaveLength(1);
  });

  it("refuses decisions it cannot place, from the call itself", async () => {
    const conversation = await interruptedConversation();
    const toolProviders = gatedWipe(toolbox(["wipe", "read"]));
    const approve = (toolCallId: string) => ({ toolCallId, approved: true });
    const refused: Array<Record<string, unknown>> = [
      { messages: conversation, approvals: [approve("c2")] },
      { messages: conversation, approvals: [approve("c1"), approve("c1")] },
      { prompt: "go", approvals: [approve("c1")] },
      { messages: [user, { role: "assistant", content: "", toolCalls: [wipeCall, wipeCall] }] },
    ];
    for (const inputs of refused) {
      const { buffered, streamSeen } = await resume({ toolProviders, inputs });
      expect(buffered.error).toMatchObject({ code: "ERR_INVALID_INPUT" });
      expect(streamSeen.inputs).toHaveLength(0);
      const stream = await createAgentStream(
        { metadata: { name: "stream" }, model: streamingModel([], { inputs: [] }), toolProviders },
        ctx,
      );
      await expect(stream.invoke(inputs)).rejects.toMatchObject({ code: "ERR_INVALID_INPUT" });
    }
  });
});

describe("an agent's approver", () => {
  it("is asked about each gated call with the call and its tool, whichever source gated it", async () => {
    const reviewer = approver(() => ({ decision: "approve" }));
    const box = toolbox(["wipe", "read", "send"], { toolRequiresApproval: (name) => name === "send" });
    box.listTools = () => [
      { name: "wipe", description: "Erase a disk.", parameters: { type: "object" } },
      { name: "read", parameters: { type: "object" } },
      { name: "send", parameters: { type: "object" } },
    ];
    await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel(
          [
            {
              tools: [
                { name: "wipe", id: "c1", args: { disk: "a" } },
                { name: "read", id: "c2" },
                { name: "send", id: "c3" },
              ],
            },
            { answer: "done" },
          ],
          { inputs: [] },
        ),
        toolProviders: gatedWipe(box),
        maxParallelTools: 1,
        ...reviewer.config,
      },
      ctx,
    ).then(async (stream) => {
      for await (const part of (await stream.invoke({ prompt: "go" })).output) void part;
    });
    expect(reviewer.asked).toEqual([
      {
        toolCall: { id: "c1", name: "wipe", arguments: { disk: "a" } },
        tool: { name: "wipe", description: "Erase a disk.", parameters: { type: "object" } },
      },
      {
        toolCall: { id: "c3", name: "send", arguments: {} },
        tool: { name: "send", description: "", parameters: { type: "object" } },
      },
    ]);
    expect(box.ran).toEqual(["wipe", "read", "send"]);
  });

  it("has its target resolved when a run starts, failing one in which nothing is gated before any model request", async () => {
    const toolProviders = [{ provider: toolbox(["read"]) }];
    // Not a reference and not an instance.
    const config = { approver: { invoke: {}, inputs: {}, result: {} } };
    const { buffered, bufferedSeen } = await runAgents({
      plans: [{ answer: "done" }],
      toolProviders,
      config,
    });
    expect(buffered.error).toMatchObject({ code: "ERR_REF_UNRESOLVED" });
    expect(bufferedSeen.inputs).toHaveLength(0);

    const streamSeen = { inputs: [] };
    const stream = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel([{ answer: "done" }], streamSeen),
        toolProviders,
        ...config,
      },
      ctx,
    );
    // The call is rejected, not the iteration.
    await expect(stream.invoke({ prompt: "go" })).rejects.toMatchObject({ code: "ERR_REF_UNRESOLVED" });
    expect(streamSeen.inputs).toHaveLength(0);
  });

  it("approves: one decision, then the tool's result", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, streamed } = await runAgents({
      plans: wipeThenRead,
      toolProviders: gatedWipe(box),
      config: { maxParallelTools: 1, ...approver(() => ({ decision: "approve", reason: "safe" })).config },
    });
    const decision = { toolCallId: "c1", name: "wipe", decision: "approve", reason: "safe" };
    expect(streamed.parts.slice(4, 9)).toEqual([
      { type: "tool-approval-decision", approvalDecision: decision },
      {
        type: "tool-result",
        toolResult: { toolCallId: "c1", name: "wipe", content: "wipe ran", output: "wipe ran" },
      },
      { type: "message", message: { role: "tool", content: "wipe ran", toolCallId: "c1" } },
      expect.objectContaining({ type: "tool-result" }),
      expect.objectContaining({ type: "message" }),
    ]);
    expect(partsOf(streamed.parts, "tool-approval-decision")).toHaveLength(1);
    expect(buffered.result).toMatchObject({ text: "done", approvalDecisions: [decision] });
    expect(buffered.result).not.toHaveProperty("interrupt");
    expect(box.ran).toEqual(["wipe", "read", "wipe", "read"]);
  });

  it("rejects exactly as a human denial does, and never reaches the tool", async () => {
    const box = toolbox(["wipe", "read"]);
    const rejected = await runAgents({
      plans: wipeThenRead,
      toolProviders: gatedWipe(box),
      config: approver(() => ({ decision: "reject", reason: "too risky" })).config,
    });
    const human = await resume({
      toolProviders: gatedWipe(toolbox(["wipe", "read"])),
      inputs: {
        messages: await interruptedConversation(),
        approvals: [{ toolCallId: "c1", approved: false, reason: "too risky" }],
      },
    });
    const outcome = (parts: typeof rejected.streamed.parts) => ({
      result: partsOf(parts, "tool-result").find((p) => p.toolResult.toolCallId === "c1"),
      message: partsOf(parts, "message").find((p) => p.message.toolCallId === "c1"),
    });
    expect(outcome(rejected.streamed.parts)).toEqual(outcome(human.streamed.parts));
    expect(outcome(rejected.streamed.parts).result!.toolResult.denied).toBe(true);
    const types = rejected.streamed.parts.map((p) => p.type);
    const decided = types.indexOf("tool-approval-decision");
    const c1Result = rejected.streamed.parts.findIndex(
      (p) => p.type === "tool-result" && p.toolResult.toolCallId === "c1",
    );
    expect(decided).toBeLessThan(c1Result);
    expect(types[c1Result + 1]).toBe("message");
    expect(rejected.buffered.result!.text).toBe("done");
    expect(box.ran).toEqual(["read", "read"]);
  });

  it("defers: the decision, then the run ends asking as it does with no approver", async () => {
    const box = toolbox(["wipe", "read"]);
    const { buffered, streamed } = await runAgents({
      plans: wipeThenRead,
      toolProviders: gatedWipe(box),
      config: approver(() => ({ decision: "defer" })).config,
    });
    const decision = { toolCallId: "c1", name: "wipe", decision: "defer" };
    expect(streamed.parts.filter((p) => p.type.startsWith("tool-approval") || p.type === "finish")).toEqual([
      { type: "tool-approval-decision", approvalDecision: decision },
      { type: "tool-approval-request", toolCall: wipeCall },
      { type: "finish", usage: expect.anything(), finishReason: "tool-calls", interrupt: "approval" },
    ]);
    expect(buffered.result).toMatchObject({
      interrupt: "approval",
      approvalRequests: [wipeCall],
      approvalDecisions: [decision],
    });
    expect(box.ran).toEqual(["read", "read"]);
  });

  it("on a resume is asked once about an undecided call and never about a decided one", async () => {
    const conversation = await interruptedConversation();
    const decided = approver(() => ({ decision: "approve" }));
    await resume({
      toolProviders: gatedWipe(toolbox(["wipe", "read"])),
      config: decided.config,
      inputs: { messages: conversation, approvals: [{ toolCallId: "c1", approved: true }] },
    });
    expect(decided.asked).toEqual([]);

    const deferring = approver(() => ({ decision: "defer" }));
    const { buffered, bufferedSeen, streamSeen } = await resume({
      toolProviders: gatedWipe(toolbox(["wipe", "read"])),
      config: deferring.config,
      inputs: { messages: conversation },
    });
    // Once per agent.
    expect(deferring.asked).toHaveLength(2);
    expect(buffered.result).toMatchObject({ interrupt: "approval", approvalRequests: [wipeCall] });
    expect([bufferedSeen.inputs.length, streamSeen.inputs.length]).toEqual([0, 0]);
  });

  it("fails the run when it throws, even under onToolError: feedback, leaving the tool unrun", async () => {
    const box = toolbox(["wipe", "read"]);
    const failure = new InvokeError("ERR_REVIEW_UNAVAILABLE", "the reviewer is down");
    const { buffered, streamed } = await runAgents({
      plans: wipeThenRead,
      toolProviders: gatedWipe(box),
      config: {
        onToolError: "feedback",
        ...approver(() => {
          throw failure;
        }).config,
      },
    });
    expect(buffered.error).toBe(failure);
    expect(streamed.error).toBe(failure);
    expect(box.ran).not.toContain("wipe");
  });

  it("fails the run on an answer that is not a decision", async () => {
    const answers = [
      { decision: "maybe" },
      { decision: "reject", reason: 7 },
      { decision: "approve", reason: null },
      { decision: "approve", verdict: "safe" },
      ["approve"],
      "approve",
    ];
    for (const answer of answers) {
      const { buffered, streamed } = await runAgents({
        plans: wipeThenRead,
        toolProviders: gatedWipe(toolbox(["wipe", "read"])),
        config: approver(() => answer).config,
      });
      const invalid = {
        code: "ERR_AGENT_APPROVAL_DECISION_INVALID",
        data: { toolCallId: "c1", name: "wipe" },
      };
      expect(buffered.error).toMatchObject(invalid);
      expect(streamed.error).toMatchObject(invalid);
    }
  });

  it("is cancelled with the turn while it is deciding", async () => {
    let cancellations = 0;
    const hanging = (source: ReturnType<typeof createCancellationSource>) => ({
      approver: {
        invoke: {
          invoke: (inputs: unknown, invokeCtx?: InvokeContext) =>
            new Promise((resolve, reject) => {
              invokeCtx!.cancellation.onCancelled(() => {
                cancellations += 1;
                reject(new InvokeError(ERR_INVOKE_CANCELLED, "approver cancelled"));
              });
              source.cancel("turn cancelled");
            }),
        },
        inputs: {},
        result: {},
      },
    });
    const plans: CallPlan[] = [{ tools: [{ name: "wipe", id: "c1" }] }];
    const toolProviders = gatedWipe(toolbox(["wipe"]));
    // Each agent gets a turn of its own: the first to run cancels its source.
    let source = createCancellationSource();
    const { buffered } = await runAgents({
      plans,
      toolProviders,
      config: hanging(source),
      invokeCtx: source.context,
    });
    expect(buffered.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(cancellations).toBe(1);

    source = createCancellationSource();
    const stream = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel(plans, { inputs: [] }),
        toolProviders,
        ...hanging(source),
      },
      ctx,
    );
    const streamed = await drain((await stream.invoke({ prompt: "go" }, source.context)).output);
    expect(streamed.error).toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(cancellations).toBe(2);
  });

  it("has the tool it approved cancelled when the consumer stops reading at the decision, under maxParallelTools: 1", async () => {
    let cancellations = 0;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const box = toolbox(["wipe"], {
      callTool: (name, args, invokeCtx) =>
        new Promise((resolve, reject) => {
          invokeCtx!.cancellation.onCancelled(() => {
            cancellations += 1;
            reject(new InvokeError(ERR_INVOKE_CANCELLED, "tool cancelled"));
          });
          started();
        }),
    });
    const stream = await createAgentStream(
      {
        metadata: { name: "stream" },
        model: streamingModel([{ tools: [{ name: "wipe", id: "c1" }] }], { inputs: [] }),
        toolProviders: gatedWipe(box),
        maxParallelTools: 1,
        ...approver(() => ({ decision: "approve" })).config,
      },
      ctx,
    );
    const iterator = (await stream.invoke({ prompt: "go" })).output[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) throw new Error("the run ended without reporting a decision");
      if (step.value.type === "tool-approval-decision") break;
    }
    await running;
    await iterator.return?.();
    expect(cancellations).toBe(1);
  });

  it("shares the parallel bound: an ask and the run it approves hold one slot back to back", async () => {
    const twoGated: CallPlan[] = [
      {
        tools: [
          { name: "wipe", id: "c1" },
          { name: "wipe", id: "c3" },
        ],
      },
      { answer: "done" },
    ];
    const timeline = async (maxParallelTools: number) => {
      const log: string[] = [];
      const box = toolbox(["wipe"]);
      box.callTool = async () => {
        log.push("run");
        return "ok";
      };
      const reviewer = approver(async (call) => {
        log.push(`ask ${call.id}`);
        // Lets a second ask start, when the bound allows one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { decision: "approve" };
      });
      const stream = await createAgentStream(
        {
          metadata: { name: "stream" },
          model: streamingModel(twoGated, { inputs: [] }),
          toolProviders: gatedWipe(box),
          maxParallelTools,
          ...reviewer.config,
        },
        ctx,
      );
      for await (const part of (await stream.invoke({ prompt: "go" })).output) void part;
      return log;
    };
    expect(await timeline(1)).toEqual(["ask c1", "run", "ask c3", "run"]);
    expect(await timeline(2)).toEqual(["ask c1", "ask c3", "run", "run"]);
  });
});
