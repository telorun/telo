import { readApplicationArguments } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { parseApplicationArguments } from "../src/application-arguments.js";
import { resolveApplicationEnv } from "../src/application-env.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { SchemaValidator } from "../src/schema-validator.js";

/** The suite shape: a repeatable flag, a positional filter, a numeric flag, a
 *  boolean flag and a port — every binding form at once. */
const APP = {
  kind: "Telo.Application",
  metadata: { name: "Suite" },
  variables: {
    include: {
      type: "array",
      items: { type: "string" },
      arg: "include",
      default: ["**/tests/*.yaml"],
    },
    filter: { type: "string", arg: { position: 0 }, default: "" },
    concurrency: { type: "integer", minimum: 1, arg: { flag: "concurrency", short: "c" }, default: 3 },
    verbose: { type: "boolean", arg: "verbose", env: "SUITE_VERBOSE", default: false },
  },
  ports: {
    http: { arg: "port", env: "PORT", default: 8080 },
  },
};

function resolve(argv: string[], env: Record<string, string> = {}) {
  return resolveApplicationEnv(APP, env, new SchemaValidator(), undefined, argv);
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    return (error as Error).message;
  }
  throw new Error("expected the resolution to fail");
}

describe("application arguments — values", () => {
  it("falls back to the defaults when the command line is empty", () => {
    expect(resolve([])).toEqual({
      variables: { include: ["**/tests/*.yaml"], filter: "", concurrency: 3, verbose: false },
      secrets: {},
      ports: { http: 8080 },
    });
  });

  it("collects a repeated flag, reads each token by the items type, and fills positions", () => {
    const { variables, ports } = resolve([
      "--include",
      "a.yaml",
      "--include=b.yaml",
      "-c",
      "2",
      "--verbose",
      "--port",
      "9000",
      "sql",
    ]);
    expect(variables).toEqual({
      include: ["a.yaml", "b.yaml"],
      filter: "sql",
      concurrency: 2,
      verbose: true,
    });
    expect(ports).toEqual({ http: 9000 });
  });

  it("prefers the command line over the environment, and the environment over the default", () => {
    expect(resolve(["--no-verbose"], { SUITE_VERBOSE: "true" }).variables.verbose).toBe(false);
    expect(resolve([], { SUITE_VERBOSE: "true", PORT: "7000" })).toMatchObject({
      variables: { verbose: true },
      ports: { http: 7000 },
    });
  });

  it("prefers a value supplied by name over the command line", () => {
    const { variables } = resolveApplicationEnv(
      APP,
      {},
      new SchemaValidator(),
      { variables: { filter: "from-parent" } },
      ["from-argv"],
    );
    expect(variables.filter).toBe("from-parent");
  });

  it("reads every token after `--` as positional", () => {
    expect(resolve(["--", "--include"]).variables.filter).toBe("--include");
  });
});

describe("application arguments — refusals", () => {
  it("refuses a flag nothing declares, naming what is declared", () => {
    expect(failure(() => resolve(["--inculde", "x"]))).toContain(
      "unknown option --inculde (it declares: --include, --concurrency, --verbose, --port, <filter>)",
    );
  });

  it("collects every error rather than stopping at the first", () => {
    const message = failure(() => resolve(["--concurrency", "zero", "a", "b", "--port"]));
    expect(message).toContain("argument --concurrency: value \"zero\" is not a valid integer");
    expect(message).toContain("unexpected argument 'b'");
    expect(message).toContain("--port expects a value");
  });

  it("validates a command-line value against the entry's schema", () => {
    expect(failure(() => resolve(["--concurrency", "0"]))).toContain("concurrency:");
  });

  it("refuses a non-array binding given twice, and a value on a boolean flag", () => {
    expect(failure(() => resolve(["-c", "1", "--concurrency", "2"]))).toContain(
      "--concurrency was given more than once",
    );
    expect(failure(() => resolve(["--verbose=yes"]))).toContain("--verbose is a boolean flag");
  });

  it("says how to spell a short option's value when it is attached", () => {
    expect(failure(() => resolve(["-c2"]))).toContain(
      "-c2: a short option takes its value as the next argument — write -c 2",
    );
    expect(failure(() => resolve(["-c=2"]))).toContain("write -c 2");
  });

  it("refuses every token when the application declares no arguments", () => {
    const message = failure(() =>
      resolveApplicationEnv({ metadata: { name: "Bare" } }, {}, new SchemaValidator(), undefined, ["--x"]),
    );
    expect(message).toContain("unknown option --x (it declares no arguments)");
  });

  it("names every channel an entry binds when none supplies a value", () => {
    const message = failure(() =>
      resolveApplicationEnv(
        { variables: { token: { type: "string", arg: "token", env: "TOKEN" } } },
        {},
        new SchemaValidator(),
        undefined,
        [],
      ),
    );
    expect(message).toContain(
      "token: argument --token was not given and environment variable TOKEN is not set (no default)",
    );
  });
});

describe("application arguments — --help", () => {
  it("answers the usage instead of resolving anything", () => {
    const result = resolve(["--concurrency", "not-a-number", "--help"]);
    expect(result.variables).toEqual({});
    expect(result.help).toBe(
      [
        "Usage: Suite [--include <string>]... [--concurrency|-c <integer>] [--[no-]verbose] [--port <integer>] [<filter>]",
        "",
        "Arguments:",
        '  <filter>  [string; default: ""]',
        "",
        "Options:",
        '      --include <string>...    [default: ["**/tests/*.yaml"]]',
        "  -c, --concurrency <integer>  [default: 3]",
        "      --[no-]verbose           [default: false; env: SUITE_VERBOSE]",
        "      --port <integer>         [default: 8080; env: PORT]",
        "",
      ].join("\n"),
    );
  });

  it("reads `--help` after `--` as a positional", () => {
    expect(resolve(["--", "--help"]).variables.filter).toBe("--help");
  });

  it("reads `--help` as a flag's value where a flag takes the next token", () => {
    const result = resolve(["--include", "--help"]);
    expect(result.help).toBeUndefined();
    expect(result.variables.include).toEqual(["--help"]);
  });
});

describe("parseApplicationArguments", () => {
  it("reads a negative number as a positional, not an option", () => {
    const { bindings } = readApplicationArguments({
      variables: { offset: { type: "integer", arg: { position: 0 } } },
    });
    expect(parseApplicationArguments(bindings, ["-5"])).toEqual({
      values: { variables: { offset: "-5" }, ports: {} },
      help: false,
      errors: [],
    });
  });
});

describe("Kernel — a load that answered --help", () => {
  it("exposes the usage and refuses to boot, since no input was resolved", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: Greet
variables:
  name:
    type: string
    arg: { position: 0 }
    default: world
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {}, argv: ["--help"] });
    await kernel.load("memory://app");
    expect(kernel.applicationHelp).toContain("Usage: Greet [<name>]");
    await expect(kernel.boot()).rejects.toMatchObject({
      code: "ERR_KERNEL_STATE_INVALID",
      message: expect.stringContaining("load() answered --help"),
    });
  });
});
