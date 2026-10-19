import { describe, expect, it } from "vitest";

import {
  askAboutResourcePrompt,
  explainRunFailurePrompt,
  fixDiagnosticPrompt,
} from "../prepared-prompts";

describe("the text an entry point prepares", () => {
  it("names a diagnostic's code, file, line and message", () => {
    expect(
      fixDiagnosticPrompt({ code: "UNDEFINED_KIND", file: "apps/todo/telo.yaml", line: 12, message: "Kind 'Http.Sever' is not defined." }),
    ).toBe("Fix this diagnostic: UNDEFINED_KIND at `apps/todo/telo.yaml` line 12\n\nKind 'Http.Sever' is not defined.");
  });

  it("names a resource's kind, name and file", () => {
    expect(askAboutResourcePrompt({ kind: "Http.Server", name: "api", file: "telo.yaml" })).toBe(
      "About the resource `api` (Http.Server) in `telo.yaml`: ",
    );
  });

  it("names a failed run's application and failure, with its output when there is any", () => {
    const run = { application: "Todo", file: "apps/todo/telo.yaml", failure: ["Exited with code 1"] };
    expect(explainRunFailurePrompt({ ...run, output: null })).toBe(
      "Explain this failure of the application `Todo` (`apps/todo/telo.yaml`):\n\nExited with code 1",
    );
    expect(explainRunFailurePrompt({ ...run, output: "boom\n" })).toBe(
      "Explain this failure of the application `Todo` (`apps/todo/telo.yaml`):\n\nExited with code 1\n\n" +
        "Last lines of its output:\n\n```\nboom\n```",
    );
  });
});
