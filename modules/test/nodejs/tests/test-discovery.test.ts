import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTests } from "../src/test-discovery.js";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

let root: string;

function write(rel: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "kind: Telo.Application\n");
}

function discovered(exclude: string[]): string[] {
  return discoverTests(root, ["**/tests/*.yaml"], exclude).map((file) =>
    path.relative(root, file).split(path.sep).join("/"),
  );
}

/** Every directory the walk listed, relative to the root. */
function listedDirectories(run: () => void): string[] {
  const listing = vi.mocked(fs.readdirSync);
  listing.mockClear();
  run();
  return listing.mock.calls
    .map(([dir]) => path.relative(root, String(dir)).split(path.sep).join("/"))
    .sort();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-test-discovery-"));
  write("modules/a/tests/one.yaml");
  write("modules/a/tests/__fixtures__/app/tests/inner.yaml");
  write("modules/a/node_modules/dep/tests/vendored.yaml");
  write(".claude/worktrees/other/modules/a/tests/one.yaml");
  write(".claude/worktrees/other/node_modules/dep/tests/vendored.yaml");
  write("apps/site/tests/app.yaml");
  write("nested/.claude/tests/kept.yaml");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("test discovery", () => {
  it("selects the tests no exclusion rules out", () => {
    expect(discovered(["**/__fixtures__/**", ".claude/**", "apps/"])).toEqual([
      "modules/a/tests/one.yaml",
      "nested/.claude/tests/kept.yaml",
    ]);
  });

  it("never lists a directory an exclusion or the hard deny tier discards whole", () => {
    const listed = listedDirectories(() => discovered(["**/__fixtures__/**", ".claude/**", "apps/"]));
    expect(listed).toEqual([
      "",
      "modules",
      "modules/a",
      "modules/a/tests",
      "nested",
      "nested/.claude",
      "nested/.claude/tests",
    ]);
  });

  it("keeps walking a directory an exclusion only partly covers", () => {
    write("modules/a/tests/skip-me.yaml");
    expect(discovered(["**/tests/skip-*.yaml"])).toEqual([
      ".claude/worktrees/other/modules/a/tests/one.yaml",
      "apps/site/tests/app.yaml",
      "modules/a/tests/__fixtures__/app/tests/inner.yaml",
      "modules/a/tests/one.yaml",
      "nested/.claude/tests/kept.yaml",
    ]);
  });

  it("prunes nothing by exclusion when the list carries a negation", () => {
    const listed = listedDirectories(() => discovered([".claude/**", "!.claude/worktrees/**"]));
    expect(listed).toContain(".claude/worktrees/other/modules/a/tests");
    expect(listed).not.toContain("modules/a/node_modules");
  });
});
