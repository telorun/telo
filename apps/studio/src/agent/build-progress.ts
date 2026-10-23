import { splitUserText } from "./editor-selection";
import { splitAgentText } from "./questions";
import type { AgentStatus, AssistantMessage, ChatMessage, ToolCallView } from "./types";

/** What the latest turn is doing while it runs. */
export type BuildStep = { kind: "thinking" } | { kind: "replying" } | { kind: "tool"; tool: ToolCallView };

/** How the latest turn ended. */
export type BuildOutcome =
  | { kind: "question" }
  | { kind: "max-steps" }
  | { kind: "stopped" }
  | { kind: "failed"; message: string }
  | { kind: "replied" };

export type BuildPhase =
  | { kind: "starting" }
  | { kind: "preparing" }
  | { kind: "stopping" }
  | { kind: "working"; step: BuildStep | null }
  | { kind: "ended"; outcome: BuildOutcome };

/** The latest turn of the workspace's conversation, as the empty workspace
 *  shows it in place of the request input. */
export interface BuildProgress {
  /** What the user asked, without the editor selections it carried. */
  request: string | null;
  phase: BuildPhase;
  /** Files the turn created or modified and did not delete afterwards, in the
   *  order they were first written. */
  files: string[];
}

const BUSY: ReadonlySet<AgentStatus> = new Set(["launching", "seeding", "streaming", "stopping"]);

/** Null while the conversation is empty and nothing runs: nothing has been
 *  asked, so the empty workspace keeps its request input. */
export function buildProgress(
  messages: readonly ChatMessage[],
  status: AgentStatus,
  error: string | null,
): BuildProgress | null {
  if (messages.length === 0 && !BUSY.has(status)) return null;

  let userAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userAt = i;
      break;
    }
  }
  const user = userAt === -1 ? null : messages[userAt];
  const reply = messages.slice(userAt + 1).find((m): m is AssistantMessage => m.role === "assistant") ?? null;
  const request = user?.role === "user" ? splitUserText(user.text).prose.trim() || null : null;

  return { request, phase: phaseOf(status, reply, error), files: reply ? writtenFiles(reply) : [] };
}

function phaseOf(status: AgentStatus, reply: AssistantMessage | null, error: string | null): BuildPhase {
  switch (status) {
    case "launching":
      return { kind: "starting" };
    case "seeding":
      return { kind: "preparing" };
    case "stopping":
      return { kind: "stopping" };
    case "streaming":
      return { kind: "working", step: reply ? currentStep(reply) : null };
  }
  if (!reply) return error ? { kind: "ended", outcome: { kind: "failed", message: error } } : { kind: "working", step: null };
  return { kind: "ended", outcome: outcomeOf(reply, error) };
}

function currentStep(reply: AssistantMessage): BuildStep | null {
  for (let i = reply.parts.length - 1; i >= 0; i--) {
    const part = reply.parts[i];
    if (part.kind === "tool") return { kind: "tool", tool: part.tool };
    if (part.kind === "text") return { kind: "replying" };
    if (part.kind === "thinking") return { kind: "thinking" };
  }
  return null;
}

function outcomeOf(reply: AssistantMessage, error: string | null): BuildOutcome {
  if (reply.stopped) return { kind: "stopped" };
  if (reply.error) return { kind: "failed", message: reply.error };
  // An error after a completed reply is the turn's too: its files never reached the editor.
  if (error) return { kind: "failed", message: error };
  if (reply.limit === "max-steps") return { kind: "max-steps" };
  const lastText = reply.parts.findLast((part) => part.kind === "text");
  if (lastText?.kind === "text" && splitAgentText(lastText.text).some((segment) => segment.kind === "questions")) {
    return { kind: "question" };
  }
  return { kind: "replied" };
}

function writtenFiles(reply: AssistantMessage): string[] {
  const files: string[] = [];
  for (const part of reply.parts) {
    if (part.kind !== "tool" || part.tool.state !== "done") continue;
    for (const change of part.tool.changes ?? []) {
      const at = files.indexOf(change.path);
      if (change.status === "deleted") {
        if (at !== -1) files.splice(at, 1);
      } else if (at === -1) {
        files.push(change.path);
      }
    }
  }
  return files;
}
