import type { UnresolvedApplicationInput } from "@telorun/kernel";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  InputInterrupted,
  readAnswerLine,
  terminalPrompter,
  type PromptInterrupts,
} from "../src/application-input-prompt.js";
import { Output } from "../src/output.js";

const quiet: PromptInterrupts = { subscribe: () => () => {}, raise: () => {} };

function recorder() {
  const chunks: string[] = [];
  return { stream: { isTTY: false, write: (chunk: string) => void chunks.push(chunk) }, text: () => chunks.join("") };
}

describe("reading an answer", () => {
  it("takes exactly one line and leaves the rest for whoever reads stdin next", async () => {
    const input = new PassThrough();
    input.write("first answer\r\nsecond line\nthird");
    await expect(readAnswerLine(input, false, quiet)).resolves.toBe("first answer");
    expect(input.readableFlowing).toBeNull();

    // A later reader attaching a listener gets everything after the answer.
    const rest: string[] = [];
    input.on("data", (chunk) => rest.push(String(chunk)));
    input.end();
    await new Promise((resolve) => input.once("end", resolve));
    expect(rest.join("")).toBe("second line\nthird");
  });

  it("reads the end of input as no answer", async () => {
    const input = new PassThrough();
    input.end();
    await expect(readAnswerLine(input, false, quiet)).resolves.toBeNull();
  });

  it("is interrupted by Ctrl-C", async () => {
    let interrupt = () => {};
    const interrupts: PromptInterrupts = {
      subscribe: (listener) => {
        interrupt = listener;
        return () => {};
      },
      raise: () => {},
    };
    const reading = readAnswerLine(new PassThrough(), false, interrupts);
    interrupt();
    await expect(reading).rejects.toBeInstanceOf(InputInterrupted);
  });
});

describe("asking for an input", () => {
  const input: UnresolvedApplicationInput = {
    id: "variables.mode",
    block: "variables",
    name: "mode",
    env: "APP_MODE",
    arg: "--mode",
    sensitive: false,
    type: "string",
    schema: { type: "string", enum: ["fast", "safe"], minLength: 2 },
    description: "How it runs",
    refusal: "mode: / must be equal to one of the allowed values",
  };

  it("names the variable, flag, type, identity, constraints and the last refusal on stderr", async () => {
    const stderr = recorder();
    const stdout = recorder();
    const answers = new PassThrough();
    answers.write("safe\n");
    const prompter = terminalPrompter(answers, new Output({ format: "text", stdout: stdout.stream, stderr: stderr.stream, env: {} }), quiet);
    await expect(prompter.ask(input)).resolves.toBe("safe");
    expect(stderr.text()).toBe(
      "APP_MODE, --mode  How it runs  [string; variables.mode]\n" +
        '  one of "fast", "safe"; length at least 2\n' +
        "  refused: mode: / must be equal to one of the allowed values\n" +
        "APP_MODE: ",
    );
    expect(stdout.text()).toBe("");
  });

  it("names a JSON value and a secret as such, and confirms only on yes", async () => {
    const stderr = recorder();
    const answers = new PassThrough();
    answers.write("{}\nYes\n\n");
    const prompter = terminalPrompter(answers, new Output({ format: "text", stdout: recorder().stream, stderr: stderr.stream, env: {} }), quiet);
    await prompter.ask({ ...input, id: "secrets.shape", block: "secrets", sensitive: true, type: "object", schema: {}, refusal: undefined, description: undefined, arg: undefined });
    expect(stderr.text()).toContain("APP_MODE  [JSON; secret; secrets.shape]\nAPP_MODE (hidden): ");
    await expect(prompter.confirm("Save?")).resolves.toBe(true);
    await expect(prompter.confirm("Save?")).resolves.toBe(false);
  });
});
