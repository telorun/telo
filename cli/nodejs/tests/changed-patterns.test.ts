import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeScope } from "../src/commands/changed.js";

/**
 * What a matched file DEPENDS on is the whole of this command's behaviour: an
 * over-broad coverage runs a suite for the wrong reason, and an under-anchored
 * one silently skips it. So coverage and selection are pinned directly.
 */

const roots: string[] = [];

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-changed-"));
  roots.push(root);
  return fs.realpathSync(root);
}

function write(root: string, relative: string, text: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function importBlock(imports: Record<string, string>): string {
  const entries = Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`);
  return entries.length ? `imports:\n${entries.join("\n")}\n` : "";
}

function moduleAt(root: string, dir: string, imports: Record<string, string> = {}, extra = ""): void {
  write(
    root,
    `${dir}/telo.yaml`,
    `kind: Telo.Library\nmetadata:\n  name: ${path.basename(dir)}\n${importBlock(imports)}${extra}`,
  );
}

function testAt(root: string, file: string, imports: Record<string, string>): void {
  write(root, file, `kind: Telo.Application\nmetadata:\n  name: T\n${importBlock(imports)}`);
}

function scopeOf(root: string): ChangeScope {
  const files = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => fs.statSync(path.join(root, entry)).isFile());
  return new ChangeScope(root, files);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("telo changed — what a matched file depends on", () => {
  it("covers a telo.yaml's directory and every relatively-imported sibling", () => {
    const root = repo();
    moduleAt(root, "apps/agent", { Chat: "./chat", Assert: "../../modules/assert" });
    moduleAt(root, "apps/agent/chat");
    moduleAt(root, "modules/assert");

    expect(scopeOf(root).coverage("apps/agent/telo.yaml")).toEqual([
      "/apps/agent/**",
      "/apps/agent/chat/**",
      "/modules/assert/**",
    ]);
  });

  it("does not follow a pinned remote import", () => {
    const root = repo();
    moduleAt(root, "examples/chat", { Console: "oci://ghcr.io/telorun/console@0.9.0" });

    expect(scopeOf(root).coverage("examples/chat/telo.yaml")).toEqual(["/examples/chat/**"]);
  });

  it("covers another manifest by itself, its fixtures and its imports — never its directory", () => {
    // `examples/test-suite-live.yaml` owns no directory: anchoring `examples/**`
    // made a gate meant to watch two examples fire on every one of them.
    const root = repo();
    moduleAt(root, "modules/http");
    moduleAt(root, "modules/run");
    testAt(root, "modules/http/tests/upload.yaml", { Http: "../", Run: "../../run" });

    expect(scopeOf(root).coverage("modules/http/tests/upload.yaml")).toEqual([
      "/modules/http/tests/__fixtures__/**",
      "/modules/http/tests/upload.yaml",
      "/modules/http/**",
      "/modules/run/**",
    ]);
  });

  it("follows a manifest a test runs by path rather than importing it", () => {
    // `Assert.Manifest` / `App.Instance` name the application under test with a
    // `source:` — no import edge, and outside `__fixtures__/`.
    const root = repo();
    moduleAt(root, "modules/assert");
    write(
      root,
      "examples/greet/telo.yaml",
      "kind: Telo.Application\nmetadata:\n  name: Greet\nimports:\n  Assert: ../../modules/assert\n",
    );
    write(
      root,
      "examples/greet/tests/greets.yaml",
      "kind: Telo.Application\nmetadata:\n  name: T\nimports:\n  Assert: ../../../modules/assert\n" +
        "---\nkind: Assert.Manifest\nmetadata: { name: t }\nsource: ../telo.yaml\n" +
        "note: ./not-a-manifest.txt\n",
    );
    write(root, "examples/greet/tests/not-a-manifest.txt", "x");

    expect(scopeOf(root).coverage("examples/greet/tests/greets.yaml")).toEqual([
      "/examples/greet/tests/__fixtures__/**",
      "/examples/greet/tests/greets.yaml",
      "/modules/assert/**",
      "/examples/greet/**",
    ]);
  });

  it("covers the partials a manifest includes and the files its tags embed", () => {
    const root = repo();
    write(
      root,
      "tests/embeds.yaml",
      "kind: Telo.Application\nmetadata:\n  name: T\ninclude:\n  - ./parts/*.yaml\n" +
        "---\nkind: X.Y\nmetadata: { name: y }\nbody: !include-text ./data/body.txt\n",
    );
    write(root, "tests/parts/a.yaml", "kind: X.Y\nmetadata: { name: a }\n");
    write(root, "tests/data/body.txt", "hello");

    expect(scopeOf(root).coverage("tests/embeds.yaml")).toEqual([
      "/tests/__fixtures__/**",
      "/tests/embeds.yaml",
      "/tests/data/body.txt",
      "/tests/data/body.txt/**",
      "/tests/parts/*.yaml",
    ]);
  });

  it("follows the workspace dependencies of a test manifest's own controller", () => {
    const root = repo();
    write(
      root,
      "tests/own-kind.yaml",
      "kind: Telo.Application\nmetadata:\n  name: T\n---\nkind: Telo.Definition\nmetadata:\n  name: K\n" +
        "capability: Telo.Invocable\ncontrollers:\n" +
        "  - pkg:telo/local/js?path=./__fixtures__/k/k.mjs&local_path=./__fixtures__/k/src/index.ts#K\n",
    );
    write(root, "tests/__fixtures__/k/src/index.ts", "export const K = {};\n");
    write(
      root,
      "tests/__fixtures__/k/package.json",
      JSON.stringify({ name: "@x/k", dependencies: { "@x/glob": "workspace:*" } }),
    );
    write(root, "packages/glob/package.json", JSON.stringify({ name: "@x/glob" }));

    expect(scopeOf(root).coverage("tests/own-kind.yaml")).toEqual([
      "/tests/__fixtures__/**",
      "/tests/own-kind.yaml",
      "/tests/__fixtures__/k/**",
      "/packages/glob/**",
    ]);
  });

  it("covers a plain file by itself", () => {
    const root = repo();
    write(root, ".github/workflows/e2e.yml", "name: E2E\n");

    expect(scopeOf(root).coverage(".github/workflows/e2e.yml")).toEqual(["/.github/workflows/e2e.yml"]);
  });

  it("follows the workspace dependencies a module's controller source inlines", () => {
    const root = repo();
    moduleAt(
      root,
      "modules/store",
      {},
      "---\nkind: Telo.Definition\nmetadata:\n  name: Put\ncapability: Telo.Invocable\n" +
        "controllers:\n  - pkg:telo/local/js?path=./nodejs/store.mjs&local_path=./nodejs/src/index.ts#Put\n",
    );
    write(root, "modules/store/nodejs/src/index.ts", "export const Put = {};\n");
    write(
      root,
      "modules/store/nodejs/package.json",
      JSON.stringify({ name: "@x/store-build", dependencies: { "@x/glob": "workspace:*", zod: "^3" } }),
    );
    write(
      root,
      "packages/glob/package.json",
      JSON.stringify({ name: "@x/glob", dependencies: { "@x/path": "workspace:^" } }),
    );
    write(root, "packages/path/package.json", JSON.stringify({ name: "@x/path" }));

    expect(scopeOf(root).coverage("modules/store/telo.yaml")).toEqual([
      "/modules/store/**",
      "/modules/store/nodejs/**",
      "/packages/glob/**",
      "/packages/path/**",
    ]);
  });
});

describe("telo changed — which matched files a diff affects", () => {
  it("expands globs against the working directory and judges each file on its own", () => {
    const root = repo();
    moduleAt(root, "modules/http");
    moduleAt(root, "modules/run");
    moduleAt(root, "modules/sql");
    testAt(root, "modules/http/tests/upload.yaml", { Http: "../", Run: "../../run" });
    testAt(root, "modules/sql/tests/query.yaml", { Sql: "../" });
    testAt(root, "modules/sql/tests/__fixtures__/helper.yaml", { Sql: "../../" });

    const scope = scopeOf(root);
    const entries = scope.expand(
      ["modules/*/tests/*.yaml", "!modules/*/tests/__fixtures__/**"],
      path.join(root),
    );
    expect(entries).toEqual(["modules/http/tests/upload.yaml", "modules/sql/tests/query.yaml"]);

    const diff = ["modules/run/nodejs/src/sequence.ts"];
    expect(entries.filter((entry) => scope.affects(entry, diff))).toEqual([
      "modules/http/tests/upload.yaml",
    ]);
  });

  it("resolves globs against the working directory, not the repository root", () => {
    const root = repo();
    moduleAt(root, "apps/hub");
    moduleAt(root, "modules/hub");

    expect(scopeOf(root).expand(["hub/telo.yaml"], path.join(root, "apps"))).toEqual([
      "apps/hub/telo.yaml",
    ]);
  });

  it("anchors a root-level file rather than matching its name anywhere", () => {
    const root = repo();
    write(root, "package.json", "{}");
    write(root, "packages/glob/package.json", "{}");
    const scope = scopeOf(root);

    expect(scope.expand(["package.json"], root)).toEqual(["package.json"]);
    expect(scope.affects("package.json", ["packages/glob/package.json"])).toBe(false);
  });
});
