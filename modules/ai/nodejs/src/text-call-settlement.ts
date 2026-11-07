import { refuseToolCall } from "./agent-tools.js";
import type { Conversation } from "./conversation.js";
import {
  NOT_RUN,
  textCallHeader,
  textCallResult,
  textResultPart,
  withheldNotice,
  type TextCall,
  type TextResultPart,
} from "./text-calls.js";
import { settleToolCall, type ToolSettlement } from "./tool-approval.js";
import type { AgentStreamPart, ApprovalDecision, ToolApproval, ToolCall, ToolResultRecord } from "./types.js";

/**
 * How a reply's text calls are settled, for both agents: one at a time, in
 * order, each through the dispatch a JSON call takes — approval, its span,
 * cancellation, `onToolError`, the result bound — so a call sees the effects
 * of every call before it. A failed call stops the later ones, which are
 * answered as not run; the first call that waits for a decision ends the
 * settling and the later ones stay pending, so the answered calls are always a
 * prefix of the reply's.
 *
 * Yields each approver decision, each `tool-result` (marked `origin: text`)
 * and, when any call was answered, the one user message carrying their result
 * parts. Returns the call left waiting, if any.
 */
export async function* settleTextCalls(
  settlement: ToolSettlement,
  calls: readonly TextCall[],
  approvals: ReadonlyMap<string, ToolApproval>,
  conversation: Conversation,
): AsyncGenerator<AgentStreamPart, ToolCall | undefined> {
  const parts: TextResultPart[] = [];
  let stopped = false;
  let waiting: ToolCall | undefined;
  for (const call of calls) {
    let record: ToolResultRecord;
    let text: string;
    if (stopped) {
      record = { toolCallId: call.id, name: call.tool, content: "", error: true };
      text = `${textCallHeader(call)}\n${NOT_RUN}`;
    } else if (call.form === "withheld") {
      record = { toolCallId: call.id, name: call.tool, content: "", error: true };
      text = withheldNotice(call);
    } else {
      settlement.ctx?.cancellation.throwIfCancelled();
      const decisions: ApprovalDecision[] = [];
      const outcome =
        call.form === "unevaluated"
          ? await refuseToolCall(
              call.toolCall,
              call.failure,
              settlement.onToolError,
              settlement.maxToolResultBytes,
              settlement.spans,
              settlement.agent,
              settlement.ctx,
            )
          : await settleToolCall(
              settlement,
              call.toolCall,
              approvals.get(call.id),
              settlement.ctx,
              (decision) => decisions.push(decision),
            );
      for (const approvalDecision of decisions) {
        yield { type: "tool-approval-decision", approvalDecision };
      }
      if (outcome === undefined) {
        waiting = call.toolCall;
        break;
      }
      record = outcome;
      text = textCallResult(call, outcome.content);
    }
    if (record.error) stopped = true;
    yield {
      type: "tool-result",
      toolResult: { ...record, content: text, origin: "text" },
    };
    parts.push(textResultPart(call, text));
  }
  if (parts.length > 0) yield await conversation.append({ role: "user", content: parts });
  return waiting;
}
