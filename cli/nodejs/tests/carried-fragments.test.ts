import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pendingFragments } from "../src/release/workspace-plan.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function fragment(cwd: string, name: string, body: string): void {
  const file = path.join(cwd, ".changes/pending", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `modules:\n  modules/a: Fixed\nbody: ${body}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("--carried-by", () => {
  it("drops the pending fragments the ref carries, and nothing without one", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-carried-fragments-")));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    fragment(root, "fixed-shipped.yaml", "Shipped on the branch");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "cut");
    git(root, "branch", "release");
    fragment(root, "fixed-main.yaml", "Main only");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main");

    const sources = (ref: string | undefined) => pendingFragments(root, ref).map((entry) => entry.source);
    expect(sources("release")).toEqual([".changes/pending/fixed-main.yaml"]);
    expect(sources(undefined)).toEqual([".changes/pending/fixed-main.yaml", ".changes/pending/fixed-shipped.yaml"]);
  });
});
