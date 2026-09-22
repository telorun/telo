import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePatterns } from "../src/commands/changed.js";

/**
 * What a `telo changed` argument MEANS is the whole of this command's
 * behaviour, and it is invisible in the exit code a CI gate reads — an
 * over-broad pattern reports "changed" for the wrong reason and an
 * under-anchored one silently reports "unchanged". So the patterns are pinned
 * directly.
 */

const roots: string[] = [];

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-changed-"));
  roots.push(root);
  return fs.realpathSync(root);
}

function write(root: string, relative: string, text: string): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

function moduleAt(root: string, dir: string, imports: Record<string, string> = {}): void {
  const importBlock = Object.entries(imports)
    .map(([alias, source]) => `  ${alias}: ${source}`)
    .join("\n");
  write(
    root,
    `${dir}/telo.yaml`,
    `kind: Telo.Library\nmetadata:\n  name: ${path.basename(dir)}\n` +
      (importBlock ? `imports:\n${importBlock}\n` : ""),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("telo changed — what an argument stands for", () => {
  it("anchors a module directory and every relatively-imported sibling", () => {
    const root = repo();
    moduleAt(root, "apps/agent", { Chat: "./chat", Assert: "../../modules/assert" });
    moduleAt(root, "apps/agent/chat");
    moduleAt(root, "modules/assert");

    expect(resolvePatterns(root, [path.join(root, "apps/agent")])).toEqual([
      "apps/agent/**",
      "apps/agent/chat/**",
      "modules/assert/**",
    ]);
  });

  it("does not follow a pinned remote import", () => {
    const root = repo();
    moduleAt(root, "examples/chat-console", { Console: "oci://ghcr.io/telorun/console@0.9.0" });

    expect(resolvePatterns(root, [path.join(root, "examples/chat-console")])).toEqual([
      "examples/chat-console/**",
    ]);
  });

  it("matches a manifest that is not a telo.yaml literally, never anchoring its directory", () => {
    // `examples/test-suite-live.yaml` parses as an application but owns no
    // directory: anchoring `examples/**` made a gate meant to watch two
    // examples fire on every one of them.
    const root = repo();
    moduleAt(root, "modules/test");
    write(
      root,
      "examples/test-suite-live.yaml",
      "kind: Telo.Application\nmetadata:\n  name: LiveSuite\nimports:\n  Test: ../modules/test\n",
    );

    expect(resolvePatterns(root, [path.join(root, "examples/test-suite-live.yaml")])).toEqual([
      "examples/test-suite-live.yaml",
    ]);
  });

  it("spells every pattern against the repository root, not the working directory", () => {
    // `git diff --name-only` reports root-relative paths wherever it runs, so a
    // cwd-relative pattern matches nothing — silently, and in the skip
    // direction.
    const root = repo();
    moduleAt(root, "apps/hub");
    write(root, "docs/guide.md", "# guide\n");

    const before = process.cwd();
    process.chdir(path.join(root, "apps"));
    try {
      expect(resolvePatterns(root, ["./hub", "../docs/guide.md"])).toEqual([
        "apps/hub/**",
        "docs/guide.md",
      ]);
    } finally {
      process.chdir(before);
    }
  });

  it("keeps a plain path, a glob and a deleted file literal", () => {
    const root = repo();
    write(root, ".github/workflows/e2e.yml", "name: E2E\n");
    fs.mkdirSync(path.join(root, "starters"));

    expect(
      resolvePatterns(root, [
        path.join(root, ".github/workflows/e2e.yml"),
        path.join(root, "modules/*/telo.yaml"),
        path.join(root, "starters"),
      ]),
    ).toEqual([".github/workflows/e2e.yml", "modules/*/telo.yaml", "starters/**"]);
  });
});
