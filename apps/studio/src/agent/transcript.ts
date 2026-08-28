import type { ChatMessage, ToolCallView } from "./types";

/** What a resume needs to know: the request that was cut off, and what its
 *  tools had already accomplished when it was. */
export interface ResumePoint {
  request: string;
  /** One entry per distinct thing the interrupted turn did, latest outcome
   *  first-appearance ordered. Empty when it was cut off before any tool ran. */
  done: ToolCallView[];
}

/** How many tool lines a resume message carries. A turn may make 40 tool calls,
 *  so this bites within a single turn as well as across a chain of resumes —
 *  which is why what it keeps is the TAIL: the most recent writes are the ones
 *  whose state the agent still has to reconcile, and the oldest are the least
 *  likely to still describe the disk. */
const MAX_REPORTED_TOOLS = 20;

/** The path a tool acted on, when its arguments name one. Read generically —
 *  every file tool spells it `path`, and a tool that does not has nothing to
 *  report here. Never the whole argument object: `write_file` carries the
 *  file's entire contents, which is already on disk and would dwarf the
 *  message it was summarising. */
function toolPath(tool: ToolCallView): string | undefined {
  const args = tool.args;
  if (!args || typeof args !== "object") return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path ? path : undefined;
}

function outcome(tool: ToolCallView): string {
  // A tool still marked running is one whose result never arrived — the turn
  // died mid-call. Reported as unknown rather than as either verdict: a half
  // written file is exactly what the agent has to go and look at.
  if (tool.state === "running") return "started, outcome unknown";
  if (tool.state === "error") return "failed";
  if (tool.checkExitCode != null) {
    return tool.checkExitCode === 0 ? "telo check passed" : "telo check reported errors";
  }
  return "done";
}

/**
 * The last request the user made, for a turn that never produced an answer.
 *
 * Anchored on the last USER message rather than on the failed assistant bubble:
 * a turn can fail before any bubble exists, and a reply that half-streamed is
 * still an unanswered request. Returns null when there is nothing to resume —
 * an empty transcript, or one whose last user message was already answered by a
 * turn that reached its `finish` record. Half a reply is not an answer, which is
 * exactly what a lost stream leaves behind.
 *
 * A resume message carries the request it resumes (`resumedRequest`), so a CHAIN
 * of them collapses: the request is the original one, and `done` accumulates
 * across every attempt at it. Without that, a second resume would quote the
 * first resume's own text and report only the second attempt's tools, losing
 * what the first one wrote.
 */
export function resumePoint(messages: ChatMessage[]): ResumePoint | null {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      last = i;
      break;
    }
  }
  if (last === -1) return null;
  // Answered, or deliberately ended: a cancelled turn is not unfinished work.
  const ended = (m: ChatMessage) => m.role === "assistant" && (m.completed || m.stopped);
  if (messages.slice(last + 1).some(ended)) return null;

  const request = messages[last].resumedRequest ?? messages[last].text;
  if (!request.trim()) return null;

  // Walk back over the resume messages of this same request to its original.
  let origin = last;
  while (messages[origin].resumedRequest !== undefined) {
    let previous = -1;
    for (let i = origin - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        previous = i;
        break;
      }
    }
    if (previous === -1) break;
    origin = previous;
  }

  // Latest outcome per (tool, path). Re-setting a key keeps its position, so the
  // list stays in the order the work first happened in while each line reports
  // where that target ended up — which is what the agent has to reconcile.
  const byTarget = new Map<string, ToolCallView>();
  for (const message of messages.slice(origin + 1)) {
    if (message.role !== "assistant") continue;
    for (const tool of message.tools) {
      const key = JSON.stringify([tool.name, toolPath(tool) ?? ""]);
      byTarget.set(key, tool);
    }
  }
  return { request, done: [...byTarget.values()] };
}

/**
 * The message a resume sends.
 *
 * It repeats the request because the interrupted turn's own record is gone: the
 * agent persists a turn's message only at end-of-stream, and the container that
 * held it is what died. What it adds is the work already done — the one thing
 * the workspace cannot say on its own, since a file on disk does not say who
 * wrote it or whether it validated.
 *
 * With no tools to report this is the original request verbatim, which is
 * exactly what a turn that died before acting should be sent.
 */
export function formatResumeRequest(resume: ResumePoint): string {
  if (resume.done.length === 0) return resume.request;

  const shown = resume.done.slice(-MAX_REPORTED_TOOLS);
  const lines = shown.map((tool) => {
    const path = toolPath(tool);
    return `- ${tool.name}${path ? ` \`${path}\`` : ""} — ${outcome(tool)}`;
  });
  const omitted = resume.done.length - shown.length;
  if (omitted > 0) lines.push(`- …and ${omitted} earlier tool ${omitted === 1 ? "call" : "calls"}`);

  return [
    "Resume an interrupted turn. You were cut off partway through this request:",
    "",
    resume.request,
    "",
    "Before the interruption you had already run:",
    ...lines,
    "",
    "Those changes are on disk. Read what is actually there before rewriting it, and continue from where that left off rather than starting again.",
  ].join("\n");
}
