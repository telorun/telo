import { describe, expect, it } from "vitest";
import { RUN_OPTIONAL_VALUE_SHAPES, RUN_OPTIONS } from "../src/commands/run.js";
import { GLOBAL_OPTIONS } from "../src/global-options.js";
import {
  splitRunInvocation as split,
  valuedOptionSpellings,
  type CliOptions,
} from "../src/run-invocation.js";

const COMMANDS = new Set(["run", "check", "install"]);

/** The tables the CLI itself registers with yargs. */
const CLI: CliOptions = {
  options: { ...GLOBAL_OPTIONS, ...RUN_OPTIONS },
  optionalValueShapes: RUN_OPTIONAL_VALUE_SHAPES,
};

function splitRunInvocation(tokens: string[], commands: ReadonlySet<string>) {
  return split(tokens, commands, CLI);
}

describe("splitRunInvocation — the application's arguments start after the path", () => {
  it("gives every token after the path to the application, CLI flags included", () => {
    expect(splitRunInvocation(["run", "--verbose", "app.yaml", "--verbose", "--watch", "x"], COMMANDS)).toEqual({
      cliTokens: ["run", "--verbose", "app.yaml"],
      applicationArgs: ["--verbose", "--watch", "x"],
    });
  });

  it("splits the default command the same way", () => {
    expect(splitRunInvocation(["-w", "app.yaml", "--include", "a"], COMMANDS)).toEqual({
      cliTokens: ["-w", "app.yaml"],
      applicationArgs: ["--include", "a"],
    });
  });

  it("skips the value of a valued CLI option when finding the path", () => {
    expect(splitRunInvocation(["-o", "json", "run", "app.yaml"], COMMANDS)).toEqual({
      cliTokens: ["-o", "json", "run", "app.yaml"],
      applicationArgs: [],
    });
    expect(splitRunInvocation(["--startup-profile", "p.json", "app.yaml", "a"], COMMANDS).applicationArgs).toEqual([
      "a",
    ]);
  });

  it("reads a port after --inspect as its value, and never the path", () => {
    expect(splitRunInvocation(["run", "--inspect", "0.0.0.0:9230", "app.yaml"], COMMANDS).cliTokens).toEqual([
      "run",
      "--inspect=0.0.0.0:9230",
      "app.yaml",
    ]);
    expect(splitRunInvocation(["run", "--inspect", "app.yaml", "x"], COMMANDS)).toEqual({
      cliTokens: ["run", "--inspect=", "app.yaml"],
      applicationArgs: ["x"],
    });
  });

  it("leaves every other command untouched", () => {
    const tokens = ["check", "a.yaml", "--verbose"];
    expect(splitRunInvocation(tokens, COMMANDS)).toEqual({ cliTokens: tokens, applicationArgs: undefined });
  });

  it("leaves a run with no path to yargs", () => {
    expect(splitRunInvocation(["run", "--help"], COMMANDS)).toEqual({
      cliTokens: ["run", "--help"],
      applicationArgs: undefined,
    });
  });
});

describe("valuedOptionSpellings — which CLI options consume the next token", () => {
  it("classifies every valued option the CLI registers, aliases included", () => {
    const rules = valuedOptionSpellings(CLI);
    expect([...rules.keys()].sort()).toEqual(["--inspect", "--output", "--startup-profile", "-o"]);
    expect(rules.get("--output")).toBe("always");
    expect(rules.get("--startup-profile")).toBe("always");
    expect(rules.get("--inspect")).toMatchObject({ name: "inspect" });
  });

  it("refuses an optional-valued option that declares no value shape", () => {
    expect(() =>
      valuedOptionSpellings({ options: { "cache-dir": { type: "string" } }, optionalValueShapes: {} }),
    ).toThrow("--cache-dir takes an optional value but declares no shape");
  });

  it("recognizes a new required-valued option from its declaration alone", () => {
    const cli: CliOptions = {
      options: { ...CLI.options, "cache-dir": { type: "string", requiresArg: true } },
      optionalValueShapes: CLI.optionalValueShapes,
    };
    expect(split(["run", "--cache-dir", "/x", "app.yaml", "a"], COMMANDS, cli)).toEqual({
      cliTokens: ["run", "--cache-dir", "/x", "app.yaml"],
      applicationArgs: ["a"],
    });
  });
});
