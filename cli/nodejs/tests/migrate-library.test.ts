import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/commands/migrate.js";
import { Output, installOutput } from "../src/output.js";

const consumers = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../analyzer/library-migration-conformance/consumers",
);

let scratch: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = undefined;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-migrate-library-"));
  fs.cpSync(path.join(consumers, "__fixtures__"), path.join(scratch, "__fixtures__"), { recursive: true });
});
afterEach(() => {
  process.exitCode = exitCode;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A consumer dir in the scratch, copied from a vector or written from `files`. */
function consumer(name: string, files?: Record<string, string>): string {
  const dir = path.join(scratch, name);
  if (files) {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
  } else {
    fs.cpSync(path.join(consumers, name), dir, { recursive: true });
    fs.rmSync(path.join(dir, "expected.json"), { force: true });
  }
  return dir;
}

const read = (dir: string, file = "telo.yaml") => fs.readFileSync(path.join(dir, file), "utf-8");

async function run(paths: string[], format: "text" | "json" = "text") {
  let stdout = "";
  let stderr = "";
  const restore = installOutput(
    new Output({
      format,
      stdout: { isTTY: false, write: (c: string) => ((stdout += c), true) },
      stderr: { isTTY: false, write: (c: string) => ((stderr += c), true) },
      env: {},
    }),
  );
  process.exitCode = undefined;
  try {
    await migrate({ paths });
  } finally {
    restore();
  }
  const status = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout, stderr, status, json: format === "json" ? JSON.parse(stdout) : undefined };
}

describe("telo migrate over library migrations", () => {
  it("writes a rewrite under the consumer's alias keeping its comment, and a second run reports nothing", async () => {
    const dir = consumer("link", {
      "telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: Library }",
        "lang: en",
        "imports: { U: ../__fixtures__/ui }",
        "targets: []",
        "---",
        "kind: U.Page",
        "metadata: { name: authors }",
        "path: /authors",
        "children:",
        "  # The list of authors lives on its own page.",
        "  - { type: link, text: Authors, href: { path: /authors } }",
        "",
      ].join("\n"),
    });
    const first = await run([dir]);
    expect(read(dir)).toContain(
      "  # The list of authors lives on its own page.\n  - { type: link, text: Authors, to: { kind: U.Navigate, address: { path: /authors } } }\n",
    );
    expect(first.stdout).toContain("UI_LINK_HREF_MOVED (Ui)");
    expect(first.status).toBe(0);
    const second = await run([dir]);
    expect(second.stdout).toContain("Nothing to migrate");
    expect(second.status).toBe(0);
  });

  it("renders a renamed key fresh, drops its comment and names it, keeping the moved value", async () => {
    const dir = consumer("rename-under-any-alias", {
      "telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: Accounts }",
        "lang: en",
        "imports: { Db: ../__fixtures__/sqlite }",
        "targets: []",
        "---",
        "kind: Db.Schema",
        "metadata: { name: schema } # the schema",
        "tables:",
        "  - users # first",
        "# Backfill before `name` becomes NOT NULL.",
        "beforeMigrations:",
        "  20260501_backfill_names: { statement: \"UPDATE users SET name = '' WHERE name IS NULL\" }",
        "",
      ].join("\n"),
    });
    const { stderr } = await run([dir]);
    expect(read(dir)).toBe(
      [
        "kind: Telo.Application",
        "metadata: { name: Accounts }",
        "lang: en",
        "imports: { Db: ../__fixtures__/sqlite }",
        "targets: []",
        "---",
        "kind: Db.Schema",
        "metadata: { name: schema } # the schema",
        "tables:",
        "  - users # first",
        "prepare:",
        "  20260501_backfill_names: { statement: \"UPDATE users SET name = '' WHERE name IS NULL\" }",
        "",
      ].join("\n"),
    );
    expect(stderr).toContain("telo.yaml:11:1  comment dropped: # Backfill before `name` becomes NOT NULL.");
  });

  it("keeps the unchanged commented entries of a node byte for byte", async () => {
    const keep = ["keep1: one # c1", "# c2", "keep2: [two]", "keep3: { three: 3 } # c3", "# c4", "keep4: null", "keep5: true # c5"];
    const dir = consumer("keep", {
      "telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: Keep }",
        "lang: en",
        "imports: { E: ../__fixtures__/edge }",
        "targets: []",
        "---",
        "kind: E.Pair",
        "metadata: { name: pair }",
        "p: 2 # moved",
        ...keep,
        "",
      ].join("\n"),
    });
    await run([dir]);
    const text = read(dir);
    expect(text).toContain(`\n${keep.join("\n")}\nq: 2\n`);
    expect(text).not.toContain("# moved");
  });

  it("writes the other nodes, leaves a failing node as written and exits 1 with the same output twice", async () => {
    const dir = consumer("failures");
    const first = await run([dir], "json");
    expect(first.status).toBe(1);
    expect(first.json.ok).toBe(false);
    expect(first.json.failed.length).toBeGreaterThan(0);
    expect(first.json.failed[0]).toMatchObject({ module: "Edge" });
    expect(first.json.failed[0].migration).not.toBe("MIGRATION_FAILED");
    expect(first.json.failed[0].migration).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(first.json.failed[0].message).not.toMatch(/^The migration /);
    expect(first.json.rewrites).toBeGreaterThan(0);
    expect(read(dir)).toContain("kind: E.Cycle\nmetadata: { name: cycle }\na: 1\n");
    const second = await run([dir], "json");
    expect(second.status).toBe(1);
    expect(second.json.rewrites).toBe(0);
    expect(second.json.failed).toEqual(first.json.failed);
  });

  it("withholds a hand-over group with an anchored member and writes the others", async () => {
    const dir = consumer("hand-over-account");
    const original = read(dir);
    fs.writeFileSync(
      path.join(dir, "telo.yaml"),
      original.replace(
        "children: [{ type: composite, ref: !ref me }, { type: composite, ref: !ref card }]",
        "children: [&settingsNode { type: composite, ref: !ref me }, { type: composite, ref: !ref card }]",
      ),
    );
    const { json, status } = await run([dir], "json");
    const text = read(dir);
    expect(status).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.unwritable).toBe(1);
    expect(json.files[0].unwritable[0]).toMatchObject({ migration: "VIEWS_DATA_REPLACED", path: "/pages/1/children/0" });
    expect(json.files[0].unwritable[0].reason).toMatch(
      /^the hand-over of `me` \(.*telo\.yaml:7:1\) has an unwritable member — .*telo\.yaml:\d+:16 holds the anchor `settingsNode`\. Remove the anchor and run again\.$/,
    );
    expect(text).toContain("kind: V.Data\nmetadata: { name: me }");
    expect(text).toContain("&settingsNode { type: composite, ref: !ref me }");
    expect(text).toContain("kind: V.Query\nmetadata: { name: orders }");
  });

  it("reports a node holding an alias unwritable and leaves it unchanged", async () => {
    const dir = consumer("alias", {
      "telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: Alias }",
        "lang: en",
        "imports: { U: ../__fixtures__/ui }",
        "targets: []",
        "---",
        "kind: U.Page",
        "metadata: { name: authors }",
        "path: &p /authors",
        "children:",
        "  - { type: link, text: Authors, href: { path: *p } }",
        "",
      ].join("\n"),
    });
    const before = read(dir);
    const { json, status } = await run([dir], "json");
    expect(status).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.files[0].unwritable[0].reason).toContain("holds an alias `*p`");
    expect(read(dir)).toBe(before);
  });

  it("repairs a library named as a path, never through the consumer, in either order", async () => {
    const first = path.join(scratch, "first");
    const second = path.join(scratch, "second");
    for (const dir of [first, second]) fs.cpSync(path.join(consumers, "referent-supplied"), dir, { recursive: true });

    await run([first]);
    expect(read(first, "panel/telo.yaml")).toContain("resources: { data: { kind: V.Data } }");
    await run([path.join(first, "panel")]);

    await run([path.join(second, "panel")]);
    await run([second]);

    for (const file of ["telo.yaml", "panel/telo.yaml"]) expect(read(first, file)).toBe(read(second, file));
    expect(read(first, "panel/telo.yaml")).toContain("resources: { data: { kind: V.View } }");
  });

  it("names a core rewrite inside a block scalar as not written, leaves the file and exits 1", async () => {
    const dir = consumer("block", {
      "telo.yaml": [
        "kind: Telo.Library",
        "metadata: { name: Block }",
        "---",
        "kind: Telo.Definition",
        "metadata: { name: Widget }",
        "capability: Telo.Invocable",
        "schema:",
        "  type: object",
        "  properties:",
        "    cols:",
        "      type: array",
        "      x-telo-context-element-from-item: |-",
        "        rows",
        "",
      ].join("\n"),
    });
    const before = read(dir);
    const text = await run([dir]);
    expect(text.status).toBe(1);
    expect(text.stderr).toContain(
      "not written: telo.yaml:12:41 (/schema/properties/cols/x-telo-context-element-from-item) sits in a block scalar, which cannot carry the edit. Fix it by hand.".replace("telo.yaml", path.relative(process.cwd(), path.join(dir, "telo.yaml"))),
    );
    expect(read(dir)).toBe(before);
    const json = await run([dir], "json");
    expect(json.status).toBe(1);
    expect(json.json.ok).toBe(false);
    expect(json.json.files[0].unwritable[0].reason).toContain("sits in a block scalar, which cannot carry the edit. Fix it by hand.");
  });
});
