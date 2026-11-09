import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carriedBy, releasedBy } from "../src/release/carried-changes.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function write(cwd: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
}

function commit(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

const FILES = [".changeset/cut.md", ".changeset/picked.md", ".changeset/own.md", ".changes/pending/fix.yaml"];

/** Cut at `cut.md`; after the cut main adds `picked.md`, `own.md` and a `fix.yaml`
 *  of its own, while the branch takes `picked.md` unchanged, consumes it, and
 *  consumes a `fix.yaml` of other content. */
function history(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-carried-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".changeset/cut.md", "cut\n");
  commit(root, "cut");
  git(root, "branch", "release");
  write(root, ".changeset/picked.md", "picked\n");
  write(root, ".changeset/own.md", "own\n");
  write(root, ".changes/pending/fix.yaml", "main\n");
  commit(root, "main after the cut");
  git(root, "switch", "-q", "release");
  write(root, ".changeset/picked.md", "picked\n");
  write(root, ".changes/pending/fix.yaml", "branch\n");
  commit(root, "pick");
  fs.rmSync(path.join(root, ".changeset/picked.md"));
  fs.rmSync(path.join(root, ".changes/pending/fix.yaml"));
  commit(root, "release");
  git(root, "switch", "-q", "main");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("carried change files", () => {
  it("are those of the same path and content at the merge base or written on the ref since", () => {
    const root = history();
    expect([...carriedBy({ cwd: root, files: FILES, ref: "release" })].sort()).toEqual([
      ".changeset/cut.md",
      ".changeset/picked.md",
    ]);
  });

  it("are released only once the ref's own tree no longer holds them", () => {
    const root = history();
    expect([...releasedBy({ cwd: root, files: FILES, ref: "release" })]).toEqual([".changeset/picked.md"]);
  });
});
