import { appendFailureFrame, InvokeError, RuntimeError } from "@telorun/sdk";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { startFailureText } from "../src/start-failure-text.js";

// An absolute directory on this host, so a module's file URL reads back as a path on Windows too.
const work = path.resolve("/work");

describe("the text of a failed start", () => {
  it("prints the Telo trace with files relative to the working directory, and no JavaScript stack for a coded failure", () => {
    const err = new InvokeError("ERR_USER_EXISTS", "a user exists");
    appendFailureFrame(err, () => ({
      kind: "Sql.Exec",
      name: "insertUser",
      module: pathToFileURL(path.join(work, "app", "users", "telo.yaml")).href,
      pointer: "",
      position: { line: 58, column: 3 },
    }));
    expect(startFailureText(err, work)).toBe(
      "ERR_USER_EXISTS: a user exists\n  at Sql.Exec.insertUser (app/users/telo.yaml:58:3)",
    );
  });

  it("prints the host stack of an uncoded failure beneath its cause", () => {
    const wrapper = new RuntimeError("ERR_EXECUTION_FAILED", "failed");
    (wrapper as { cause?: unknown }).cause = new TypeError("boom");
    const text = startFailureText(wrapper, work);
    expect(text).toContain("ERR_EXECUTION_FAILED: failed\ncaused by TypeError: boom\n  host stack\n    TypeError: boom");
  });
});
