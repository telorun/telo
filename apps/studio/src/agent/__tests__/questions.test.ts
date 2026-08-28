import { describe, expect, it } from "vitest";

import { formatAnswers, splitAgentText } from "../questions";

const BLOCK = `\`\`\`telo-questions
{
  "questions": [
    {
      "id": "surface",
      "question": "What should this expose?",
      "options": [
        { "label": "HTTP API", "detail": "routes on a server port", "recommended": true },
        { "label": "Scheduled job" }
      ]
    }
  ]
}
\`\`\``;

describe("splitAgentText", () => {
  it("splits prose around a question block", () => {
    const segments = splitAgentText(`A few decisions first:\n\n${BLOCK}\n\nThen I'll build it.`);
    expect(segments.map((s) => s.kind)).toEqual(["text", "questions", "text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "A few decisions first:\n\n" });
    if (segments[1].kind !== "questions") throw new Error("expected questions");
    expect(segments[1].questions).toEqual([
      {
        id: "surface",
        question: "What should this expose?",
        options: [
          { label: "HTTP API", detail: "routes on a server port", recommended: true },
          { label: "Scheduled job", detail: undefined, recommended: false },
        ],
      },
    ]);
  });

  it("leaves a message with no block as one run of prose", () => {
    expect(splitAgentText("Wrote hello-api.yaml; check passes.")).toEqual([
      { kind: "text", text: "Wrote hello-api.yaml; check passes." },
    ]);
  });

  it("reports a block whose closing fence has not streamed in yet", () => {
    const partial = 'Deciding:\n\n```telo-questions\n{ "questions": [';
    expect(splitAgentText(partial).map((s) => s.kind)).toEqual(["text", "pending"]);
  });

  // A malformed block is SHOWN, never dropped: the user still reads the
  // questions, only without the buttons.
  it("keeps an unparseable block as text", () => {
    const broken = "```telo-questions\n{ not json\n```";
    const segments = splitAgentText(broken);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("text");
    expect(segments[0].kind === "text" && segments[0].text).toContain("not json");
  });

  // A question with no options is OPEN — a fact only the user has, where any
  // option list would be invented. It is the shape, not a violation of it.
  it("reads a question with no options as an open one", () => {
    const open = '```telo-questions\n{ "questions": [{ "id": "cols", "question": "Which columns?" }] }\n```';
    const segments = splitAgentText(open);
    if (segments[0].kind !== "questions") throw new Error("expected questions");
    expect(segments[0].questions).toEqual([{ id: "cols", question: "Which columns?", options: [] }]);
  });

  it("keeps a block whose questions do not carry the declared shape as text", () => {
    const wrongShape = '```telo-questions\n{ "questions": [{ "options": [] }] }\n```';
    expect(splitAgentText(wrongShape).map((s) => s.kind)).toEqual(["text"]);
  });

  // Ids key the answer map and the render list, so two the same would collapse
  // into one answer. Shown as text rather than half-answered.
  it("keeps a block with duplicate question ids as text", () => {
    const dupes =
      '```telo-questions\n{ "questions": [' +
      '{ "id": "a", "question": "One?", "options": [{ "label": "x" }] },' +
      '{ "id": "a", "question": "Two?", "options": [{ "label": "y" }] }] }\n```';
    expect(splitAgentText(dupes).map((s) => s.kind)).toEqual(["text"]);
  });

  it("ignores a fence quoted mid-line", () => {
    const quoted = "Emit a ```telo-questions block when you need a decision.";
    expect(splitAgentText(quoted)).toEqual([{ kind: "text", text: quoted }]);
  });

  it("reads several blocks in one message", () => {
    expect(splitAgentText(`${BLOCK}\n\n${BLOCK}`).map((s) => s.kind)).toEqual([
      "questions",
      "questions",
    ]);
  });
});

describe("formatAnswers", () => {
  it("writes the answers as prose the model reads like any other message", () => {
    const questions = [
      { id: "a", question: "What should this expose?", options: [{ label: "HTTP API" }] },
      { id: "b", question: "Where does the data live?", options: [{ label: "SQLite file" }] },
    ];
    expect(formatAnswers(questions, { a: "HTTP API", b: "SQLite file" })).toBe(
      "- What should this expose? — HTTP API\n- Where does the data live? — SQLite file",
    );
  });

  it("omits a question left unanswered", () => {
    const questions = [
      { id: "a", question: "One?", options: [{ label: "Yes" }] },
      { id: "b", question: "Two?", options: [{ label: "No" }] },
    ];
    expect(formatAnswers(questions, { b: "No" })).toBe("- Two? — No");
  });
});
