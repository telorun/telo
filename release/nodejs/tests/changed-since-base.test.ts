import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedFilesSinceBase } from "../src/node/git.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function commit(cwd: string, file: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", file);
}

function repo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-since-base-")));
  roots.push(root);
  git(root, "init", "-b", "main");
  commit(root, "base.txt");
  git(root, "branch", "base");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("changedFilesSinceBase", () => {
  it("lists every file changed since the base, a release tag in range included", () => {
    const root = repo();
    commit(root, "a/one.txt");
    git(root, "tag", "v1.0.0");
    commit(root, "b/two.txt");
    expect(changedFilesSinceBase(root, "base").sort()).toEqual(["a/one.txt", "b/two.txt"]);
  });
});
