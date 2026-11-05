import { appendFailureFrame, droppedFramesOf, failureFramesOf, type ErrorValue, type FailureFrame, type LogRecord } from "@telorun/sdk";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { encodeJson } from "../src/logging/encode-json.js";
import { encodePretty } from "../src/logging/encode-pretty.js";
import { restructure } from "../src/controller-loaders/napi-loader.js";
import { toErrorValue } from "../src/logging/to-error-value.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, "__fixtures__", name);

/** Run `name` to its failure and answer what it threw. */
async function failure(name: string): Promise<unknown> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(fixture(name));
  const error = await kernel.start().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, "the fixture's run fails").toBeDefined();
  return error;
}

const summary = (frames: readonly FailureFrame[]) => frames.map((f) => `${f.kind}${f.pointer ? `#${f.pointer}` : ""}`);

describe("the frames a failure gains at each exit", () => {
  it("run innermost first through nested dispatches and end at the Application's target", async () => {
    const error = await failure("failure-location/nested.yaml");
    expect(summary(failureFramesOf(error))).toEqual([
      "Assert.Equals",
      "Run.Sequence#/steps/1",
      "Run.Sequence#/steps/0",
      "Telo.Application#/targets/0",
    ]);
    expect(failureFramesOf(error)[3]).toMatchObject({
      name: "FailureNested",
      position: { line: 7, column: 16 },
    });
  });

  it("name a template body's entry with no position", async () => {
    const error = await failure("failure-location/template-body.yaml");
    const frames = failureFramesOf(error);
    expect(frames[1]).toMatchObject({ kind: "Run.Sequence", name: "SequenceBodySteps0Inner" });
    expect(frames[1]).not.toHaveProperty("position");
    expect(frames[2]).toMatchObject({ kind: "Run.Sequence", name: "body" });
    expect(frames[2]).not.toHaveProperty("position");
  });

  it("carry the frame of a resource whose init() fails on the failure the startup raises", async () => {
    const error = (await failure("failure-trace/recursion/unready.yaml")) as { cause?: unknown };
    expect(failureFramesOf(error).map((f) => `${f.kind} ${f.name}`)).toEqual(["FailureRecursionKinds.Unready unready"]);
    expect(failureFramesOf(error)[0]).toMatchObject({ position: { line: 6, column: 1 } });
    expect(error.cause).toMatchObject({ code: "ERR_UNREADY" });
  });

  it("move to the wrapper a kernel wrap makes, leaving the wrapped value none", async () => {
    const error = (await failure("failure-trace/recursion/wrap.yaml")) as { code?: string; cause?: unknown };
    expect(error.code).toBe("ERR_EXECUTION_FAILED");
    expect(failureFramesOf(error).map((f) => `${f.kind} ${f.name}`)).toEqual([
      "FailureRecursionKinds.Forward forward",
      "Telo.Application FailureWrap",
    ]);
    expect(error.cause).toMatchObject({ code: "ERR_RESOURCE_NOT_FOUND" });
    expect(failureFramesOf(error.cause)).toEqual([]);
  });

  it("include a sequence whose targets: member refuses, at the member's place", async () => {
    const error = await failure("failure-trace/recursion/sequence-targets.yaml");
    expect(summary(failureFramesOf(error))).toEqual([
      "FailureRecursionKinds.Fail",
      "Telo.Sequence#/targets/0",
      "Telo.Application#/targets/0",
    ]);
  });

  it("are bounded at 64 with the cut counted: 100 frames of a 98-deep self-dispatch", async () => {
    // One frame for the refusing target, one per dispatching caller (98) and the Application's.
    const error = await failure("failure-trace/recursion/telo.yaml");
    expect(failureFramesOf(error)).toHaveLength(64);
    expect(droppedFramesOf(error)).toBe(36);
  });
});

const record = (error: ErrorValue): LogRecord => ({
  timestamp: 0n,
  severityNumber: 17,
  severityText: "ERROR",
  message: "request failed",
  error,
});

describe("a failure written to a log", () => {
  // An absolute directory on this host, so a module's file URL reads back as a path on Windows too.
  const work = path.resolve("/work");
  const app = path.join(work, "app");
  const source = (file: string) => pathToFileURL(path.join(app, file)).href;
  const frames: FailureFrame[] = [
    { kind: "Sql.Exec", name: "insertUser", module: source("users/telo.yaml"), pointer: "", position: { line: 58, column: 3 } },
    { kind: "Telo.Sequence", name: "createUser", module: source("users/telo.yaml"), pointer: "/steps/1" },
    { kind: "Http.Api", name: "api", module: source("telo.yaml"), pointer: "/routes/3/handler", position: { line: 18, column: 9 } },
  ];
  const thrown = Object.assign(new Error("duplicate"), { code: "ERR_SQL_CONSTRAINT" });
  for (const frame of frames) appendFailureFrame(thrown, () => frame);

  it("keeps the stack relative to the entry module's directory and the frames' full sources", () => {
    const value = toErrorValue(thrown, "[redacted]", { entryDirectory: app });
    expect(value.stack).toBe(
      [
        "at Sql.Exec.insertUser (users/telo.yaml:58:3)",
        "at Telo.Sequence.createUser#/steps/1",
        "at Http.Api.api#/routes/3/handler (telo.yaml:18:9)",
      ].join("\n"),
    );
    expect(value.frames).toEqual(frames);
    expect(value.hostStack).toBeUndefined();
    expect(JSON.parse(encodeJson(record(value))).err).toEqual({
      type: "ERR_SQL_CONSTRAINT",
      message: "duplicate",
      stack: value.stack,
      frames,
    });
  });

  it("renders in pretty with files relative to the working directory, and the host stack of an uncoded cause", () => {
    const value: ErrorValue = {
      type: "ERR_EXECUTION_FAILED",
      message: "Sql.Exec insertUser failed",
      frames,
      cause: { type: "TypeError", message: "Cannot read 'rows'", hostStack: "TypeError: Cannot read 'rows'\n    at SqlExec.invoke (/work/app/.telo/sql.mjs:814:22)" },
    };
    const text = encodePretty(record(value), { color: false, workingDirectory: work })
      .split("\n")
      .slice(1)
      .join("\n");
    expect(text).toBe(
      [
        "  ERR_EXECUTION_FAILED: Sql.Exec insertUser failed",
        "    at Sql.Exec.insertUser (app/users/telo.yaml:58:3)",
        "    at Telo.Sequence.createUser#/steps/1",
        "    at Http.Api.api#/routes/3/handler (app/telo.yaml:18:9)",
        "  caused by TypeError: Cannot read 'rows'",
        "    host stack",
        "      TypeError: Cannot read 'rows'",
        "          at SqlExec.invoke (/work/app/.telo/sql.mjs:814:22)",
      ].join("\n"),
    );
  });
});

describe("an event payload's error", () => {
  it("is built as a log line builds it: frames relative to the entry directory, no file URL", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(fixture("failure-trace/recursion/wrap.yaml"));
    const error = await kernel.start().then(
      () => undefined,
      (err: unknown) => err,
    );
    const value = kernel.logging.errorValueOf(error, undefined);
    expect(value.stack).toBe(
      ["at FailureRecursionKinds.Forward.forward (wrap.yaml:9:1)", "at Telo.Application.FailureWrap#/targets/0 (wrap.yaml:6:5)"].join("\n"),
    );
    expect(value.stack).not.toMatch(/\.m?js:|file:\/\//);
  });
});

describe("a Rust controller's error as the kernel restructures it", () => {
  const frame = { kind: "Lib.K", name: "r" };
  const raised = (fields: Record<string, unknown>) =>
    Object.assign(new Error("boom"), { teloControllerError: true, code: "ERR_CONTROLLER_PANIC" }, fields);

  it("keeps the frames and the host stack its SDK reported, whatever the code", () => {
    const value = toErrorValue(restructure(raised({ frames: [frame], hostStack: "panicked at x.rs:1" })), "[redacted]");
    expect(value).toMatchObject({ type: "ERR_CONTROLLER_PANIC", frames: [frame], hostStack: "panicked at x.rs:1" });
  });

  it("gives a coded refusal that reported no host stack none", () => {
    const value = toErrorValue(restructure(raised({ code: "NOT_FOUND", frames: [frame] })), "[redacted]");
    expect(value.hostStack).toBeUndefined();
  });

  it("refuses a malformed frames member", () => {
    expect(restructure(raised({ frames: [{ kind: "Lib.K" }] }))).toMatchObject({ code: "ERR_CONTROLLER_INVALID" });
  });
});
