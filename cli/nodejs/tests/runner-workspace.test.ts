import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceDirectory } from "../src/runner/workspace-directory.js";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-ws-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("WorkspaceDirectory", () => {
  it("writes a change set, hashes contents, and deletes", async () => {
    const ws = new WorkspaceDirectory(root);
    await ws.apply({
      write: [
        { path: "telo.yaml", content: "kind: Telo.Application\n" },
        { path: "nested/handler.yaml", content: "kind: Run.Value\n" },
      ],
    });

    // The hash is what the editor diffs against, so it is the file's own
    // content digest and the paths are relative with `/` separators — the same
    // shape the container backends' workspace service returns.
    expect(await ws.tree()).toEqual({
      files: [
        { path: "nested/handler.yaml", hash: sha256("kind: Run.Value\n") },
        { path: "telo.yaml", hash: sha256("kind: Telo.Application\n") },
      ],
    });

    expect(await ws.apply({ delete: ["nested/handler.yaml"] })).toEqual({ written: 0, deleted: 1 });
    expect((await ws.tree()).files.map((f) => f.path)).toEqual(["telo.yaml"]);
  });

  it("round-trips binary content through base64", async () => {
    const ws = new WorkspaceDirectory(root);
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    await ws.apply({ write: [{ path: "asset.bin", content: bytes.toString("base64"), encoding: "base64" }] });

    const snapshot = await ws.snapshot();
    expect(snapshot).toHaveLength(1);
    // A checkpoint re-seeds a resumed session, so it must carry bytes a text
    // encoding would corrupt — always base64, never a per-file guess.
    expect(snapshot[0]!.encoding).toBe("base64");
    expect(Buffer.from(snapshot[0]!.content, "base64")).toEqual(bytes);
  });

  it("skips the caches a workspace can rebuild", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
    fs.mkdirSync(path.join(root, ".telo"), { recursive: true });
    fs.writeFileSync(path.join(root, ".telo", "cache.json"), "{}");
    fs.writeFileSync(path.join(root, "telo.yaml"), "kind: Telo.Application\n");

    expect((await new WorkspaceDirectory(root).tree()).files.map((f) => f.path)).toEqual([
      "telo.yaml",
    ]);
  });

  it("refuses a path that escapes the workspace", async () => {
    const ws = new WorkspaceDirectory(root);
    await expect(ws.apply({ write: [{ path: "../escaped.yaml", content: "x" }] })).rejects.toThrow();
    expect(fs.existsSync(path.join(path.dirname(root), "escaped.yaml"))).toBe(false);
  });

  it("touching a file rewrites its own bytes, which is what fires the watcher", async () => {
    const ws = new WorkspaceDirectory(root);
    await ws.apply({ write: [{ path: "telo.yaml", content: "kind: Telo.Application\n" }] });
    const before = await ws.tree();
    await ws.touch("telo.yaml");
    // Same content, same hash — a reload with no edit, which is exactly what
    // `POST /v1/sessions/:id/reload` asks for.
    expect(await ws.tree()).toEqual(before);
  });

  it("reports an empty tree for a workspace that does not exist yet", async () => {
    expect(await new WorkspaceDirectory(path.join(root, "missing")).tree()).toEqual({ files: [] });
  });
});
