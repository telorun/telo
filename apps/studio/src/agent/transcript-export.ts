import { transcriptFromTurns } from "./records";
import type { AgentIdentity, AssistantMessage, Conversation, TurnRecords } from "./types";

/**
 * A conversation exported by the client, composed from `GET /conversations/{id}`
 * and the records route. JSON is lossless — the records route's turns verbatim,
 * which fold back into the same transcript; Markdown is for reading, and carries
 * what the model received rather than any tool's structured `output`.
 */

export interface ConversationExport {
  agent: { name: string; version: string; promptId: string };
  conversation: Conversation;
  turns: TurnRecords[];
}

export function exportJson(agent: AgentIdentity, conversation: Conversation, turns: TurnRecords[]): string {
  const doc: ConversationExport = {
    agent: { name: agent.name, version: agent.version, promptId: agent.promptId },
    conversation,
    turns,
  };
  return JSON.stringify(doc, null, 2);
}

/** A fence longer than any backtick run inside `text`, so the text cannot close it. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function agentSection(reply: AssistantMessage | undefined, turn: TurnRecords): string[] {
  const out: string[] = [];
  for (const part of reply?.parts ?? []) {
    switch (part.kind) {
      case "text":
        out.push(part.text);
        break;
      case "thinking":
        out.push(quoted(part.text));
        break;
      case "tool": {
        const { tool } = part;
        out.push(`**Tool \`${tool.name}\`**${tool.state === "error" ? " (failed)" : ""}`);
        out.push(fenced(asText(tool.args ?? {}), "json"));
        if (tool.state !== "running") out.push(fenced(asText(tool.output), "text"));
        break;
      }
      case "continued":
        out.push("--- Continued after an interruption ---");
        break;
      case "summary":
        out.push("--- Earlier turns were summarized for the agent ---", quoted(part.summary));
        break;
      case "title-error":
        out.push(`_Couldn't name this conversation — ${part.error.code ?? "error"}: ${part.error.message}_`);
        break;
    }
  }
  if (turn.status === "failed" && turn.error) {
    out.push(`Turn failed: ${turn.error.code ?? "error"} — ${turn.error.message}`);
  } else if (turn.status === "aborted") {
    out.push("Stopped by the user.");
  }
  return out;
}

export function exportMarkdown(conversation: Conversation, turns: TurnRecords[]): string {
  const blocks: string[] = [
    `# ${conversation.title ?? "Untitled"}`,
    [
      `Created ${conversation.createdAt}`,
      `Updated ${conversation.updatedAt}`,
      `Model ${conversation.model ?? "—"}`,
      `${conversation.totalTokens} tokens`,
      conversation.id,
    ].join(" · "),
  ];
  for (const turn of turns) {
    const [user, reply] = transcriptFromTurns([turn]).reduce<[string | undefined, AssistantMessage | undefined]>(
      ([u, a], m) => (m.role === "user" ? [m.text, a] : [u, m]),
      [undefined, undefined],
    );
    blocks.push("## You", user ?? "");
    blocks.push("## Agent", ...agentSection(reply, turn));
  }
  return blocks.join("\n\n") + "\n";
}
