import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnvFiles } from "../src/env-files.js";

let root: string;

beforeEach(() => {
  // Realpathed here only to make the fixture's own paths comparable to the
  // resolver's output; the resolver realpaths on its own (see the symlink case).
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-env-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A manifest at `<root>/<nested>/app.yaml`, with the directories created. */
function manifestAt(nested: string): string {
  const dir = path.join(root, nested);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.yaml");
  fs.writeFileSync(file, "kind: Telo.Application\n");
  return file;
}

function write(dir: string, name: string, body: string): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, name), body);
}

function markWorkspace(): void {
  fs.writeFileSync(path.join(root, "telo-workspace.yaml"), "modules:\n  - modules/*\n");
}

describe("resolveEnvFiles", () => {
  it("reads only the manifest's own directory when no workspace marker is above it", () => {
    const manifest = manifestAt("apps/one");
    write(".", ".env.local", "ENV_A=root\n");
    write("apps/one", ".env.local", "ENV_B=own\n");

    const { values } = resolveEnvFiles(manifest);

    expect(values).toEqual({ ENV_B: "own" });
  });

  it("walks up to the workspace root once the marker is present", () => {
    markWorkspace();
    const manifest = manifestAt("apps/one");
    write(".", ".env.local", "ENV_A=root\n");
    write("apps", ".env", "ENV_B=mid\n");

    const { values, loaded } = resolveEnvFiles(manifest);

    expect(values).toEqual({ ENV_A: "root", ENV_B: "mid" });
    expect(loaded).toEqual([
      path.join(root, ".env.local"),
      path.join(root, "apps", ".env"),
    ]);
  });

  it("reaches a manifest outside every release subtree", () => {
    markWorkspace();
    const manifest = manifestAt("examples/demo");
    write(".", ".env.local", "ENV_A=root\n");

    expect(resolveEnvFiles(manifest).values).toEqual({ ENV_A: "root" });
  });

  it("lets the nearest declaration win over an ancestor's", () => {
    markWorkspace();
    const manifest = manifestAt("apps/one");
    write(".", ".env.local", "ENV_A=root\n");
    write("apps/one", ".env.local", "ENV_A=near\n");

    expect(resolveEnvFiles(manifest).values.ENV_A).toBe("near");
  });

  it("prefers .env.local over .env within one directory", () => {
    markWorkspace();
    const manifest = manifestAt("apps/one");
    write("apps/one", ".env", "ENV_A=base\n");
    write("apps/one", ".env.local", "ENV_A=local\n");

    expect(resolveEnvFiles(manifest).values.ENV_A).toBe("local");
  });

  it("stops at the workspace root and never reads its parent", () => {
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-env-outer-")));
    try {
      fs.writeFileSync(path.join(outer, ".env.local"), "ENV_C=outer\n");
      const inner = path.join(outer, "repo");
      fs.mkdirSync(path.join(inner, "apps"), { recursive: true });
      fs.writeFileSync(path.join(inner, "telo-workspace.yaml"), "modules:\n  - apps/*\n");
      const manifest = path.join(inner, "apps", "app.yaml");
      fs.writeFileSync(manifest, "kind: Telo.Application\n");

      expect(resolveEnvFiles(manifest).values).toEqual({});
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("finds the marker through a symlinked manifest path", () => {
    markWorkspace();
    const manifest = manifestAt("apps/one");
    write(".", ".env.local", "ENV_A=root\n");
    const link = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-env-link-"))), "app");
    fs.symlinkSync(path.join(root, "apps", "one"), link, "dir");
    try {
      expect(resolveEnvFiles(path.join(link, "app.yaml")).values).toEqual({ ENV_A: "root" });
      expect(resolveEnvFiles(manifest).values).toEqual({ ENV_A: "root" });
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  it("reports a file it cannot read instead of treating it as absent", () => {
    markWorkspace();
    const manifest = manifestAt("apps/one");
    // A directory where a file is expected: EISDIR on read, and unlike a mode
    // change it behaves the same when the tests run as root.
    fs.mkdirSync(path.join(root, ".env.local"));
    write("apps/one", ".env", "ENV_A=own\n");

    const { values, loaded, unreadable } = resolveEnvFiles(manifest);

    expect(values).toEqual({ ENV_A: "own" });
    expect(loaded).toEqual([path.join(root, "apps", "one", ".env")]);
    expect(unreadable).toEqual([{ path: path.join(root, ".env.local"), reason: "EISDIR" }]);
  });
});
