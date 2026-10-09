import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import {
  InvokeError,
  isCancellationError,
  isSuspension,
  resolveInvocableDispatcher,
} from "@telorun/sdk";
import type { AgentSpanIdentity, SpanOpener } from "./agent-spans.js";
import {
  deniedToolRecord,
  dispatchToolCall,
  toolFailureRecord,
  type AssembledTools,
} from "./agent-tools.js";
import type { Conversation } from "./conversation.js";
import { runToolCalls } from "./tool-concurrency.js";
import type {
  AgentStreamPart,
  ApprovalDecision,
  ToolApproval,
  ToolCall,
  ToolDefinition,
  ToolResultRecord,
} from "./types.js";

/**
 * How a set of tool calls is settled, for both agents: which calls need a
 * decision, who gives it, and what each outcome records. Shared by `Ai.Agent`
 * and `Ai.AgentStream`, so the two cannot drift on what gates a call, on what a
 * denial tells the model, or on the order the record is written in.
 */

/** An agent's `approver`, as its manifest declares it. */
export interface ApproverConfig {
  /** The resource asked: a reference, an inline declaration, or — once the
   *  kernel has injected it — the live instance. */
  invoke: unknown;
  /** CEL mapping from `toolCall` and `tool` to the approver's input. */
  inputs: unknown;
  /** CEL mapping from the approver's `result` to `{ decision, reason? }`. */
  result: unknown;
}

const DECISIONS = ["approve", "reject", "defer"];

/**
 * What decides a gated call in place of the caller, for one run: its target is
 * resolved when the run starts, so an unusable `approver.invoke` fails a run
 * whether or not a call is gated. A failure here — the approver throwing, a
 * mapping failing to evaluate, an answer outside the contract — is never a tool
 * failure: it propagates whatever `onToolError` says.
 */
export class Approver {
  private readonly dispatch: (
    inputs: Record<string, unknown>,
    ctx?: InvokeContext,
  ) => Promise<unknown>;

  constructor(
    private readonly config: ApproverConfig,
    private readonly ctx: ResourceContext,
    private readonly label: string,
  ) {
    this.dispatch = resolveInvocableDispatcher(config.invoke, ctx, () => `${label}: 'approver'`);
  }

  async ask(
    call: ToolCall,
    tool: ToolDefinition,
    invokeCtx: InvokeContext | undefined,
  ): Promise<ApprovalDecision> {
    const inputs = this.ctx.expandValue(this.config.inputs, {
      toolCall: { id: call.id, name: call.name, arguments: call.arguments },
      tool: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters },
    });
    const result = await this.dispatch(inputs, invokeCtx);
    const answer = this.ctx.expandValue(this.config.result, { result }) as unknown;
    if (!isDecision(answer)) {
      throw new InvokeError(
        "ERR_AGENT_APPROVAL_DECISION_INVALID",
        `${this.label}: the approver's answer for the call to "${call.name}" is not a decision. 'approver.result' must give an object holding 'decision' as one of ${DECISIONS.join(", ")}, optionally 'reason' as a string, and no other key.`,
        { toolCallId: call.id, name: call.name },
      );
    }
    return {
      toolCallId: call.id,
      name: call.name,
      decision: answer.decision,
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    };
  }
}

/** The closed shape `approver.result` must give. */
function isDecision(
  answer: unknown,
): answer is { decision: ApprovalDecision["decision"]; reason?: string } {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return false;
  const { decision, reason, ...others } = answer as Record<string, unknown>;
  return (
    typeof decision === "string" &&
    DECISIONS.includes(decision) &&
    (reason === undefined || typeof reason === "string") &&
    Object.keys(others).length === 0
  );
}

/** What settling a set of calls runs under. */
export interface ToolSettlement {
  tools: AssembledTools;
  onToolError: "feedback" | "throw";
  maxToolResultBytes: number | undefined;
  maxParallelTools: number;
  label: string;
  spans: SpanOpener;
  agent: AgentSpanIdentity;
  /** The run's context: cancelling it reaches every running tool and approver. */
  ctx: InvokeContext | undefined;
  /** The agent's caller data. */
  context: Record<string, unknown>;
  approver?: Approver;
}

/**
 * Settle `calls`, side by side up to the agent's bound, and yield the record as
 * it is written: a `tool-approval-decision` for each ask of the approver, then
 * for each call that ran or was denied its `tool-result` and the `message` that
 * appends it to the conversation. Returns the calls still waiting for a
 * decision, in call order.
 *
 * One call, in order of precedence: a caller's decision in `approvals` (run it,
 * or deny it); otherwise the call is judged — ungated, it runs; gated, it goes
 * to the approver when there is one, and waits when there is none or the
 * approver defers. An ask and the tool run it approves hold one slot of the
 * bound, back to back.
 */
export async function* settleToolCalls(
  settlement: ToolSettlement,
  calls: readonly ToolCall[],
  approvals: ReadonlyMap<string, ToolApproval>,
  conversation: Conversation,
): AsyncGenerator<AgentStreamPart, ToolCall[]> {
  const waiting = new Set<number>();
  const steps = runToolCalls<ToolResultRecord | undefined, ApprovalDecision>(
    calls,
    settlement.maxParallelTools,
    settlement.ctx,
    (call, ctx, report) => settleToolCall(settlement, call, approvals.get(call.id), ctx, report),
    // Only an approver's answer is reported.
    settlement.approver !== undefined,
  );
  for await (const step of steps) {
    if ("event" in step) {
      yield { type: "tool-approval-decision", approvalDecision: step.event };
    } else if (step.outcome === undefined) {
      waiting.add(step.index);
    } else {
      const record = step.outcome;
      yield { type: "tool-result", toolResult: record };
      yield conversation.append({
        role: "tool",
        content: record.content,
        toolCallId: record.toolCallId,
      });
    }
  }
  return calls.filter((call, index) => waiting.has(index));
}

/** One call's outcome: its record, or nothing while it waits for a decision. */
async function settleToolCall(
  settlement: ToolSettlement,
  call: ToolCall,
  approval: ToolApproval | undefined,
  ctx: InvokeContext | undefined,
  report: (decision: ApprovalDecision) => void,
): Promise<ToolResultRecord | undefined> {
  const { tools, onToolError, maxToolResultBytes } = settlement;
  const run = () =>
    dispatchToolCall(
      call,
      tools.dispatch,
      onToolError,
      maxToolResultBytes,
      settlement.label,
      settlement.spans,
      settlement.agent,
      ctx,
      settlement.context,
    );
  if (approval) {
    return approval.approved ? run() : deniedToolRecord(call, approval.reason, maxToolResultBytes);
  }

  const target = tools.dispatch.get(call.name);
  let gated = target?.gated ?? false;
  // The provider is asked only when the entry's own lists did not gate the call.
  if (target && !gated && typeof target.provider.toolRequiresApproval === "function") {
    try {
      const required: unknown = await target.provider.toolRequiresApproval(
        target.bareName,
        call.arguments,
        settlement.context,
      );
      if (typeof required !== "boolean") {
        throw new InvokeError(
          "ERR_CONTRACT_VIOLATION",
          `${settlement.label}: the provider of tool "${call.name}" answered 'toolRequiresApproval' with ${typeof required === "string" ? JSON.stringify(required) : required === null ? "null" : `a ${typeof required}`}, not a boolean. Whether a call needs a decision is never read from anything else, so the call was not run.`,
        );
      }
      gated = required;
    } catch (err) {
      // A gate that cannot be evaluated fails the call; the tool does not run.
      if (onToolError === "throw" || isCancellationError(err) || isSuspension(err)) throw err;
      return toolFailureRecord(call, err, maxToolResultBytes);
    }
  }
  if (target && gated) {
    if (!settlement.approver) return undefined;
    const decision = await settlement.approver.ask(call, target.definition, ctx);
    report(decision);
    if (decision.decision === "defer") return undefined;
    if (decision.decision === "reject") {
      return deniedToolRecord(call, decision.reason, maxToolResultBytes);
    }
  }
  return run();
}
