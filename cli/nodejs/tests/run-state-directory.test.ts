import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunStateDirectory } from "../src/run-state-directory.js";

describe("the state directory of a plain telo run", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-state-")));
    fs.writeFileSync(path.join(root, "telo-workspace.yaml"), "{}\n");
    fs.mkdirSync(path.join(root, "examples", "durable-orders"), { recursive: true });
    fs.writeFileSync(path.join(root, "telo.yaml"), "");
    fs.writeFileSync(path.join(root, "examples", "durable-orders", "telo.yaml"), "");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const cwd = "/elsewhere";

  it("is .telo/state/_ for an app at the workspace dir", () => {
    expect(defaultRunStateDirectory({ entry: path.join(root, "telo.yaml"), packaged: false, cwd })).toBe(
      path.join(root, ".telo", "state", "_"),
    );
  });

  it("is .telo/state/<app dir relative to it>/_ for one below it, named by file or directory", () => {
    const expected = path.join(root, ".telo", "state", "examples", "durable-orders", "_");
    const dir = path.join(root, "examples", "durable-orders");
    expect(defaultRunStateDirectory({ entry: dir, packaged: false, cwd })).toBe(expected);
    expect(defaultRunStateDirectory({ entry: path.join(dir, "telo.yaml"), packaged: false, cwd })).toBe(expected);
  });

  it("anchors a packaged executable and a remote entry at the working directory with the key _", () => {
    const expected = path.join(cwd, ".telo", "state", "_");
    expect(defaultRunStateDirectory({ entry: path.join(root, "telo.yaml"), packaged: true, cwd })).toBe(expected);
    expect(defaultRunStateDirectory({ entry: "https://example.com/app/telo.yaml", packaged: false, cwd })).toBe(expected);
    expect(defaultRunStateDirectory({ entry: "oci://ghcr.io/acme/app@1.0.0", packaged: false, cwd })).toBe(expected);
  });
});
