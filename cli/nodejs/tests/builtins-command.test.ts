import { BUILTIN_VOCABULARY_ARCHIVE, selectBuiltins } from "@telorun/analyzer";
import { afterEach, describe, expect, it } from "vitest";
import { builtins } from "../src/commands/builtins.js";
import { Output, installOutput, type OutputFormat } from "../src/output.js";

function run(format: OutputFormat, names?: string[]): { stdout: string; stderr: string } {
  const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
  const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
  const restore = installOutput(new Output({ format, stdout, stderr, env: {} }));
  try {
    builtins({ names });
  } finally {
    restore();
  }
  return { stdout: stdout.text, stderr: stderr.text };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("telo builtins", () => {
  it("writes the archive the analyzer was built with, byte for byte", () => {
    expect(run("text")).toEqual({ stdout: BUILTIN_VOCABULARY_ARCHIVE, stderr: "" });
  });

  it("carries the selected bytes as one JSON string under -o json", () => {
    const selected = selectBuiltins(BUILTIN_VOCABULARY_ARCHIVE, ["Step"]);
    expect(selected.ok).toBe(true);
    const { stdout } = run("json", ["Step"]);
    expect(JSON.parse(stdout)).toBe(selected.ok ? selected.text : undefined);
  });

  it("exits non-zero naming every name there is when a name selects nothing", () => {
    const { stdout, stderr } = run("text", ["Aplication"]);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^No built-in is named 'Aplication'\. The names are:\n {2}kinds/);
    expect(process.exitCode).toBe(1);
  });
});
