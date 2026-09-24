import { describe, expect, it } from "vitest";
import { readApplicationArguments, renderArgumentSynopsis } from "../src/application-arguments.js";

function issuesOf(doc: unknown): string[] {
  return readApplicationArguments(doc).issues.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);
}

describe("readApplicationArguments", () => {
  it("reads the three binding forms, flags first and positions in order", () => {
    const { bindings, issues } = readApplicationArguments({
      variables: {
        rest: { type: "array", items: { type: "string" }, arg: { position: 1 }, default: [] },
        first: { type: "string", arg: { position: 0 }, env: "FIRST" },
        include: { type: "array", items: { type: "string" }, arg: "include", default: [] },
        verbose: { type: "boolean", arg: { flag: "verbose", short: "v" }, default: false },
      },
      ports: { http: { arg: "port", env: "PORT" } },
    });
    expect(issues).toEqual([]);
    expect(bindings).toEqual([
      { block: "variables", name: "include", form: "flag", flag: "include", valueType: "string", repeated: true },
      { block: "variables", name: "verbose", form: "flag", flag: "verbose", short: "v", valueType: "boolean", repeated: false },
      { block: "ports", name: "http", form: "flag", flag: "port", valueType: "integer", repeated: false },
      { block: "variables", name: "first", form: "position", position: 0, valueType: "string", repeated: false },
      { block: "variables", name: "rest", form: "position", position: 1, valueType: "string", repeated: true },
    ]);
  });

  it("refuses a secret on the command line", () => {
    expect(issuesOf({ secrets: { token: { type: "string", env: "T", arg: "token" } } })).toEqual([
      expect.stringMatching(/^ARG_BINDING_ON_SECRET secrets\.token\.arg: /),
    ]);
  });

  it("refuses a type the command line cannot carry", () => {
    expect(issuesOf({ variables: { cfg: { type: "object", arg: "cfg" } } })).toEqual([
      expect.stringContaining('a "object" value cannot be bound to the command line'),
    ]);
    expect(issuesOf({ variables: { xs: { type: "array", arg: "xs" } } })).toEqual([
      expect.stringContaining("must declare scalar 'items.type'"),
    ]);
    expect(issuesOf({ variables: { on: { type: "boolean", arg: { position: 0 }, default: false } } })).toEqual([
      expect.stringContaining("a boolean cannot be positional"),
    ]);
  });

  it("refuses flags that collide with the runtime's own spelling", () => {
    expect(issuesOf({ variables: { h: { type: "boolean", arg: "help", default: false } } })).toEqual([
      expect.stringContaining("flag '--help' is reserved"),
    ]);
    expect(issuesOf({ variables: { c: { type: "boolean", arg: "no-color", default: false } } })).toEqual([
      expect.stringContaining("collides with the '--no-<flag>' negation"),
    ]);
  });

  it("requires a default on a variable only the command line can set", () => {
    // A runner session and the studio supply inputs through the environment.
    expect(issuesOf({ variables: { name: { type: "string", arg: "name" } } })).toEqual([
      expect.stringContaining("an entry bound only to the command line needs a 'default:'"),
    ]);
    expect(issuesOf({ variables: { name: { type: "string", arg: "name", env: "NAME" } } })).toEqual([]);
  });

  it("refuses a gap between positions and an array before the last one", () => {
    expect(
      issuesOf({
        variables: {
          a: { type: "array", items: { type: "string" }, arg: { position: 0 }, default: [] },
          b: { type: "string", arg: { position: 2 }, default: "" },
        },
      }),
    ).toEqual([
      expect.stringContaining("only the last position may be an array"),
      expect.stringContaining("position 2 leaves position 1 unbound"),
    ]);
  });

  it("refuses a shared flag, short or position", () => {
    expect(
      issuesOf({
        variables: {
          a: { type: "string", arg: { flag: "a", short: "x" }, default: "" },
          b: { type: "string", arg: { flag: "b", short: "x" }, default: "" },
          c: { type: "string", arg: { position: 0 }, default: "" },
          d: { type: "string", arg: { position: 0 }, default: "" },
        },
      }),
    ).toEqual([
      expect.stringContaining("short flag '-x' is already bound by variables.a"),
      expect.stringContaining("position 0 is already bound by variables.c"),
    ]);
  });

  it("leaves a malformed spelling to the schema, so it is reported once", () => {
    // The built-in schema refuses each of these as a SCHEMA_VIOLATION.
    for (const arg of [{ flag: "a", alias: "b" }, "--filter", { position: -1 }, { flag: "a", short: "ab" }, 3]) {
      expect(issuesOf({ variables: { a: { type: "string", arg, default: "" } } })).toEqual([]);
    }
  });
});

describe("renderArgumentSynopsis", () => {
  it("brackets what may be left out and marks what repeats", () => {
    expect(
      renderArgumentSynopsis({
        variables: {
          target: { type: "string", arg: { position: 0 } },
          files: { type: "array", items: { type: "string" }, arg: { position: 1 }, default: [] },
          tag: { type: "array", items: { type: "string" }, arg: { flag: "tag", short: "t" } },
          level: { type: "integer", arg: "level", env: "LEVEL" },
          dryRun: { type: "boolean", arg: "dry-run", default: false },
        },
        ports: { http: { arg: "port", default: 8080 } },
      }),
    ).toBe(
      "--tag|-t <string>... [--level <integer>] [--[no-]dry-run] [--port <integer>] <target> [<files>]...",
    );
  });

  it("is empty for an application that declares no arguments", () => {
    expect(renderArgumentSynopsis({ variables: { a: { type: "string", env: "A" } } })).toBe("");
  });
});
