import { describe, expect, it } from "vitest";

import { formatResumeRequest, resumePoint } from "../transcript";
import type { ChatMessage, ToolCallView } from "../types";

const user = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "user",
  text,
  tools: [],
  ...over,
});
const assistant = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  tools: [],
  ...over,
});
const wrote = (path: string, over: Partial<ToolCallView> = {}): ToolCallView => ({
  toolCallId: `t-${path}`,
  name: "write_file",
  args: { path, content: "x".repeat(5000) },
  state: "done",
  checkExitCode: 0,
  ...over,
});

describe("resumePoint", () => {
  it("finds nothing in an empty transcript", () => {
    expect(resumePoint([])).toBeNull();
  });

  it("finds nothing once the turn reached its finish record", () => {
    expect(
      resumePoint([user("1", "build it"), assistant("2", { text: "done", completed: true })]),
    ).toBeNull();
  });

  it("resumes a turn that ended before its finish record", () => {
    expect(
      resumePoint([
        user("1", "build it"),
        assistant("2", { error: "Interrupted — the agent session ended before this turn completed." }),
      ]),
    ).toEqual({ request: "build it", done: [] });
  });

  // What a lost stream leaves behind: prose in the bubble and no finish. Reading
  // that as an answer is what would offer a button with nothing to do.
  it("treats half a streamed reply as unanswered", () => {
    expect(
      resumePoint([user("1", "build it"), assistant("2", { text: "Looking at the workspa" })]),
    ).toEqual({ request: "build it", done: [] });
  });

  it("carries the work the interrupted turn already did", () => {
    const point = resumePoint([
      user("1", "build it"),
      assistant("2", { tools: [wrote("apps/todo/telo.yaml"), wrote("apps/todo/api/telo.yaml")] }),
    ]);
    expect(point?.done.map((t) => t.args)).toEqual([
      expect.objectContaining({ path: "apps/todo/telo.yaml" }),
      expect.objectContaining({ path: "apps/todo/api/telo.yaml" }),
    ]);
  });

  it("reports each target once, at its latest outcome and first position", () => {
    const point = resumePoint([
      user("1", "build it"),
      assistant("2", {
        tools: [
          wrote("a.yaml", { checkExitCode: 1 }),
          wrote("b.yaml"),
          wrote("a.yaml", { checkExitCode: 0 }),
        ],
      }),
    ]);
    expect(point?.done).toHaveLength(2);
    expect(point?.done[0].checkExitCode).toBe(0);
    expect((point?.done[0].args as { path: string }).path).toBe("a.yaml");
  });

  it("finds nothing to resend for a blank request", () => {
    expect(resumePoint([user("1", "   ")])).toBeNull();
  });

  // A chain of resumes collapses: quoting the previous resume's own report back
  // at the agent would nest, and the first attempt's work would drop out.
  it("resumes the ORIGINAL request across a chain, accumulating the work", () => {
    const point = resumePoint([
      user("1", "build it"),
      assistant("2", { tools: [wrote("a.yaml")] }),
      user("3", "Resume an interrupted turn…", { resumedRequest: "build it" }),
      assistant("4", { tools: [wrote("b.yaml")] }),
    ]);
    expect(point?.request).toBe("build it");
    expect(point?.done.map((t) => (t.args as { path: string }).path)).toEqual(["a.yaml", "b.yaml"]);
  });

  // A cancel is an ending the user chose; offering to re-send it would re-run
  // the very request they stopped.
  it("finds nothing to resume after a stopped turn", () => {
    expect(
      resumePoint([user("1", "build it"), assistant("2", { stopped: true, text: "half" })]),
    ).toBeNull();
  });

  it("stops resuming a chain once a turn in it completed", () => {
    expect(
      resumePoint([
        user("1", "build it"),
        assistant("2", { tools: [wrote("a.yaml")] }),
        user("3", "Resume…", { resumedRequest: "build it" }),
        assistant("4", { text: "done", completed: true }),
      ]),
    ).toBeNull();
  });
});

describe("formatResumeRequest", () => {
  it("sends the request verbatim when no tool ran", () => {
    expect(formatResumeRequest({ request: "build it", done: [] })).toBe("build it");
  });

  it("reports each tool's target and outcome, and never its file contents", () => {
    const message = formatResumeRequest({
      request: "build it",
      done: [
        wrote("apps/todo/telo.yaml"),
        wrote("apps/todo/api/telo.yaml", { checkExitCode: 2 }),
        { toolCallId: "t3", name: "edit_file", args: { path: "x.yaml" }, state: "running" },
        { toolCallId: "t4", name: "list_dir", state: "done" },
      ],
    });
    expect(message).toContain("build it");
    expect(message).toContain("- write_file `apps/todo/telo.yaml` — telo check passed");
    expect(message).toContain("- write_file `apps/todo/api/telo.yaml` — telo check reported errors");
    expect(message).toContain("- edit_file `x.yaml` — started, outcome unknown");
    expect(message).toContain("- list_dir — done");
    // The write's `content` argument is thousands of characters already on disk.
    expect(message).not.toContain("xxxx");
  });

  // The cap keeps the TAIL: the most recent writes are the ones whose state the
  // agent still has to reconcile, and "earlier" then describes what was dropped.
  it("caps the list by dropping the OLDEST entries", () => {
    const done = Array.from({ length: 23 }, (_, i) => wrote(`f${i}.yaml`));
    const message = formatResumeRequest({ request: "build it", done });
    expect(message).toContain("f22.yaml");
    expect(message).toContain("f3.yaml");
    for (const dropped of ["f0.yaml", "f1.yaml", "f2.yaml"]) {
      expect(message).not.toContain(dropped);
    }
    expect(message).toContain("…and 3 earlier tool calls");
  });
});
