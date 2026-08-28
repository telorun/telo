/**
 * The agent's question block: how a turn that needs decisions from the user
 * reaches the panel.
 *
 * The agent asks by emitting one fenced ```telo-questions block of JSON in its
 * reply text (its system prompt owns the shape). It is a block in the TEXT
 * rather than a tool call because a tool result feeds the model loop straight
 * back into another step — it cannot end a turn, and ending the turn is the
 * whole point of asking. A client that does not parse the block still shows it
 * as a code block, so the questions stay readable everywhere.
 */

export interface QuestionOption {
  /** The answer, in one to four words. */
  label: string;
  /** The one consequence of choosing it. */
  detail?: string;
  /** The option the agent would pick. Exactly one per question. */
  recommended?: boolean;
}

export interface AgentQuestion {
  id: string;
  question: string;
  /** Empty for an OPEN question — one whose answer is a fact only the user has
   *  (a column name, a spreadsheet tab, a join key), where any option list would
   *  be invented. Answered by typing. */
  options: QuestionOption[];
}

/** One run of an assistant message: prose, a parsed question block, or a block
 *  whose closing fence has not streamed in yet. */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "questions"; questions: AgentQuestion[] }
  | { kind: "pending" };

const OPEN_FENCE = "```telo-questions";

/** True when `index` starts a line, give or take indentation — so a fence
 *  quoted mid-sentence or nested inside another code block is left as prose. */
function atLineStart(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

function readQuestions(json: string): AgentQuestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const raw = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const questions: AgentQuestion[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") return null;
    const { id, question, options } = entry as Record<string, unknown>;
    if (typeof question !== "string" || !question.trim()) return null;
    // An absent or empty list is an OPEN question, not a malformed one.
    if (options !== undefined && !Array.isArray(options)) return null;

    const parsedOptions: QuestionOption[] = [];
    for (const option of options ?? []) {
      if (!option || typeof option !== "object") return null;
      const { label, detail, recommended } = option as Record<string, unknown>;
      if (typeof label !== "string" || !label.trim()) return null;
      parsedOptions.push({
        label: label.trim(),
        detail: typeof detail === "string" && detail.trim() ? detail.trim() : undefined,
        recommended: recommended === true,
      });
    }
    // Ids key the answer map and the render list, so a duplicate would collapse
    // two questions into one answer and one React key. The prompt requires them
    // unique; this is the only place that can hold a model to it, and the block
    // is rejected into the text path rather than silently answering half of it.
    const id_ = typeof id === "string" && id.trim() ? id.trim() : `q${index + 1}`;
    if (questions.some((q) => q.id === id_)) return null;
    questions.push({ id: id_, question: question.trim(), options: parsedOptions });
  }
  return questions;
}

/**
 * Split an assistant message into prose and question blocks.
 *
 * A block whose JSON does not parse — or does not carry the declared shape —
 * comes back as TEXT holding the original fence, so a malformed block is shown
 * rather than swallowed: the user still reads the questions, just without the
 * buttons.
 */
export function splitAgentText(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (value.trim()) segments.push({ kind: "text", text: value });
  };

  for (;;) {
    let open = text.indexOf(OPEN_FENCE, cursor);
    while (open !== -1 && !atLineStart(text, open)) {
      open = text.indexOf(OPEN_FENCE, open + OPEN_FENCE.length);
    }
    if (open === -1) break;

    const bodyStart = text.indexOf("\n", open + OPEN_FENCE.length);
    if (bodyStart === -1) {
      // The fence line itself is still streaming.
      pushText(text.slice(cursor, open));
      segments.push({ kind: "pending" });
      return segments;
    }

    const closeMatch = /\n[ \t]*```[ \t]*(?:\n|$)/.exec(text.slice(bodyStart));
    if (!closeMatch) {
      pushText(text.slice(cursor, open));
      segments.push({ kind: "pending" });
      return segments;
    }

    const bodyEnd = bodyStart + closeMatch.index;
    const blockEnd = bodyStart + closeMatch.index + closeMatch[0].length;
    const questions = readQuestions(text.slice(bodyStart + 1, bodyEnd));

    pushText(text.slice(cursor, open));
    if (questions) segments.push({ kind: "questions", questions });
    else pushText(text.slice(open, blockEnd));
    cursor = blockEnd;
  }

  pushText(text.slice(cursor));
  return segments;
}

/**
 * The message the panel sends back when options are picked. Plain prose in the
 * agent's own words — it becomes the user's chat bubble and the model's next
 * turn alike, so it has to read as an answer rather than as a form submission.
 */
export function formatAnswers(questions: AgentQuestion[], chosen: Record<string, string>): string {
  return questions
    .filter((q) => chosen[q.id])
    .map((q) => `- ${q.question} — ${chosen[q.id]}`)
    .join("\n");
}
