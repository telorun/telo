import { serializeFragment } from "@telorun/analyzer";
import { makeTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import yargs from "yargs";
import { releaseCommand } from "../src/commands/release.js";
import { releaseImportsCommand, type ImportForm } from "../src/commands/release-imports.js";
import { upgrade } from "../src/commands/upgrade.js";
import { Output, installOutput } from "../src/output.js";
import { recordLedger } from "../src/release/apply-plan.js";
import { writeLedger } from "../src/release/ledger-store.js";
import { loadWorkspace } from "../src/release/workspace.js";
import { planWorkspace } from "../src/release/workspace-plan.js";
import { parseCommandLine } from "../src/usage-refusal.js";

const HOST = "oci.example.test";
const ORIGIN = `https://${HOST}`;
const REGISTRY = `oci://${HOST}/telorun`;
const PUBLISHED_TEXT = "kind: Telo.Library\n";
const PIN = `sha256-${createHash("sha256").update(PUBLISHED_TEXT).digest("base64url")}`;
const runPin = `${REGISTRY}/run@0.2.7#${PIN}`;

let root: string;
let tarball: Buffer;
let tarDigest: string;

const library = (name: string, version: string) =>
  `kind: Telo.Library\nmetadata:\n  name: ${name}\n  version: ${version}\n`;

function write(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function application(imports: Record<string, string>): string {
  return [
    "kind: Telo.Application",
    "metadata:",
    "  name: Consumer",
    "imports:",
    ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`),
    "",
  ].join("\n");
}

/** A published version list for `repo`, and the two-hop pull of its manifest. */
function published(repo: string, versions: string[], manifest = true): void {
  nock(ORIGIN).get(`/v2/telorun/${repo}/tags/list`).query(true).reply(200, { tags: versions });
  if (!manifest) return;
  nock(ORIGIN)
    .get(`/v2/telorun/${repo}/manifests/${versions[versions.length - 1]}`)
    .reply(200, {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: tarDigest, size: 0 },
      layers: [
        { mediaType: "application/vnd.telo.module.manifest.v1+tar", digest: tarDigest, size: tarball.length },
      ],
    });
  nock(ORIGIN).get(`/v2/telorun/${repo}/blobs/${tarDigest}`).reply(200, tarball);
}

interface Run {
  envelope: any;
  stderr: string;
  status: number | undefined;
}

async function run(paths: string[], as: ImportForm, flags: { check?: boolean; dryRun?: boolean } = {}): Promise<Run> {
  const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
  const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
  const restore = installOutput(new Output({ format: "json", stdout, stderr, env: {} }));
  process.exitCode = undefined;
  try {
    await releaseImportsCommand({ paths, as, check: flags.check ?? false, dryRun: flags.dryRun ?? false });
  } finally {
    restore();
  }
  const status = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { envelope: JSON.parse(stdout.text), stderr: stderr.text, status };
}

beforeAll(async () => {
  tarball = await makeTarGz([{ name: "telo.yaml", content: PUBLISHED_TEXT }]);
  tarDigest = `sha256:${createHash("sha256").update(tarball).digest("hex")}`;
  nock.disableNetConnect();

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-release-imports-")));
  write(
    "telo-workspace.yaml",
    `release:\n  registry: ${REGISTRY}\n  modules:\n    - modules/*\n    - blueprints/*\n    - apps/*\n    - examples/chat-app/chat\n`,
  );
  write("modules/run/telo.yaml", library("Run", "0.2.7"));
  write("modules/sql/telo.yaml", library("Sql", "1.0.0"));
  write("blueprints/web-app/telo.yaml", library("WebApp", "0.1.0"));
  write("apps/site/telo.yaml", application({}).replace("Consumer", "Site"));
  write("apps/site/Dockerfile", "FROM scratch\n");
  write("examples/chat-app/chat/telo.yaml", library("Chat", "1.0.0"));
  // Written before the ledger is recorded, so the modules' digests include them.
  write("modules/run/tests/self.yaml", application({ Run: ".." }));
  write("blueprints/web-app/example/telo.yaml", application({ Web: ".." }));

  // Every module recorded as published at the version in the tree.
  const workspace = loadWorkspace(root);
  const { targets, plan } = await planWorkspace(workspace, { rungs: {}, baseRef: "HEAD" });
  const everyModule = workspace.modules.map((module) => ({
    key: module.key,
    name: module.name,
    from: module.version,
    to: module.version,
    level: "patch" as const,
    reasons: [],
    changed: [],
    entries: [],
  }));
  writeLedger(root, await recordLedger(root, targets, { ...plan, modules: everyModule }));
}, 120_000);

afterAll(() => {
  nock.enableNetConnect();
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  nock.cleanAll();
  fs.rmSync(path.join(root, ".changes", "pending"), { recursive: true, force: true });
});

describe("telo release imports --as=published", () => {
  it("writes the registry's pin for the version in the tree", async () => {
    const file = write("examples/a/telo.yaml", application({ Run: "../../modules/run" }));
    published("run", ["0.2.4", "0.2.7"]);

    const { envelope, status } = await run([file], "published");

    expect(status).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(application({ Run: runPin }));
    expect(envelope).toMatchObject({
      ok: true,
      as: "published",
      dryRun: false,
      check: false,
      rewritten: [{ alias: "Run", source: "../../modules/run", to: runPin }],
      keptRelative: [],
      errors: [],
    });
  });

  it("keeps an import relative, exits 1 and still writes the rest, when the version is not at the registry", async () => {
    const file = write(
      "examples/a/telo.yaml",
      application({ Run: "../../modules/run", Sql: "../../modules/sql" }),
    );
    published("run", ["0.2.7"]);
    published("sql", ["0.9.0"], false);

    const { envelope, stderr, status } = await run([file], "published");

    expect(status).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(application({ Run: runPin, Sql: "../../modules/sql" }));
    expect(envelope.ok).toBe(false);
    expect(envelope.keptRelative).toEqual([
      expect.objectContaining({
        source: "../../modules/sql",
        cause: "unpublished",
        reason: `modules/sql@1.0.0 is not published at ${REGISTRY}/sql yet`,
      }),
    ]);
    expect(stderr).toContain("Sql: ../../modules/sql  kept relative — modules/sql@1.0.0 is not published");
  });

  it("keeps an import of a module the release plan still bumps relative, naming the reason", async () => {
    write(
      ".changes/pending/fixed-sql.yaml",
      serializeFragment(new Map([["modules/sql", "Fixed"]]), "A fix."),
    );
    const file = write("examples/a/telo.yaml", application({ Sql: "../../modules/sql" }));
    const before = fs.readFileSync(file, "utf8");

    const { envelope, status } = await run([file], "published");

    expect(status).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(envelope.keptRelative).toEqual([
      expect.objectContaining({
        source: "../../modules/sql",
        cause: "plan-bumped",
        reason: "modules/sql has an unreleased change (1.0.0 → 1.0.1: declared)",
      }),
    ]);
  });

  it("reports a registry that cannot answer as an error and exits 1, writing nothing for it", async () => {
    const file = write("examples/a/telo.yaml", application({ Run: "../../modules/run" }));
    const before = fs.readFileSync(file, "utf8");
    nock(ORIGIN).get("/v2/telorun/run/tags/list").query(true).reply(500);

    const { envelope, status } = await run([file], "published");

    expect(status).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(envelope.errors).toEqual([expect.objectContaining({ alias: "Run", source: "../../modules/run" })]);
  });
});

describe("telo release imports --as=relative", () => {
  it("writes the path to the module's directory, keeping the quote style, and gives the canonical bytes back", async () => {
    const canonical = application({ Run: '"../../modules/run"', Web: "'../../blueprints/web-app'" });
    const file = write("examples/b/telo.yaml", canonical);
    published("run", ["0.2.7"]);
    nock(ORIGIN).get("/v2/telorun/web-app/tags/list").query(true).reply(200, { tags: [] });

    // The blueprint is not published, so only Run takes its published form.
    expect((await run([file], "published")).status).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(
      application({ Run: `"${runPin}"`, Web: "'../../blueprints/web-app'" }),
    );

    const back = await run([file], "relative");
    expect(back.status).toBeUndefined();
    expect(back.envelope.rewritten).toEqual([
      expect.objectContaining({ source: runPin, to: "../../modules/run" }),
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe(canonical);
  });

  it("does not consult the version in the reference", async () => {
    const file = write("examples/b/telo.yaml", application({ Sql: `${REGISTRY}/sql@0.0.1#sha256-OLD` }));

    expect((await run([file], "relative")).status).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(application({ Sql: "../../modules/sql" }));
  });
});

describe("the module a manifest sits inside", () => {
  it("stays relative under --as=published", async () => {
    const test = path.join(root, "modules/run/tests/self.yaml");
    const example = path.join(root, "blueprints/web-app/example/telo.yaml");

    const { envelope, status } = await run([test, example], "published");

    expect(status).toBeUndefined();
    expect(envelope.rewritten).toEqual([]);
    expect(fs.readFileSync(test, "utf8")).toBe(application({ Run: ".." }));
    expect(fs.readFileSync(example, "utf8")).toBe(application({ Web: ".." }));
  });

  it("is written relative from its pinned form under either --as", async () => {
    for (const as of ["published", "relative"] as const) {
      const example = write(
        "blueprints/web-app/example/telo.yaml",
        application({ Web: `${REGISTRY}/web-app@0.1.0#sha256-X` }),
      );
      expect((await run([example], as)).status).toBeUndefined();
      expect(fs.readFileSync(example, "utf8")).toBe(application({ Web: ".." }));
    }
  });
});

describe("imports the command leaves alone", () => {
  it("leaves a nested library, an image module and a third-party import untouched, asking nothing", async () => {
    const consumer = application({
      Chat: "./chat",
      Site: "../../apps/site",
      Console: `oci://${HOST}/elsewhere/console@1.0.0#sha256-X`,
      Lib: "./lib",
    });
    const file = write("examples/chat-app/telo.yaml", consumer);

    for (const as of ["published", "relative"] as const) {
      const { envelope, status } = await run([file], as);
      expect(status).toBeUndefined();
      expect(envelope.rewritten).toEqual([]);
    }
    expect(fs.readFileSync(file, "utf8")).toBe(consumer);
  });
});

describe("--check and --dry-run", () => {
  it("--check exits 1 on a hand-edited pin and 0 on the command's own output, writing nothing", async () => {
    const edited = application({ Run: `${REGISTRY}/run@0.2.7#sha256-EDITED` });
    const file = write("examples/c/telo.yaml", edited);
    published("run", ["0.2.7"]);

    const failed = await run([file], "published", { check: true });
    expect(failed.status).toBe(1);
    expect(failed.envelope).toMatchObject({ ok: false, check: true });
    expect(failed.stderr).toContain(`differs — the command writes ${runPin}`);
    expect(fs.readFileSync(file, "utf8")).toBe(edited);

    write("examples/c/telo.yaml", application({ Run: runPin }));
    published("run", ["0.2.7"]);
    expect((await run([file], "published", { check: true })).status).toBeUndefined();
  });

  it("--check --as=relative lists a pinned import and passes a relative one", async () => {
    const file = write("examples/c/telo.yaml", application({ Run: runPin }));
    expect((await run([file], "relative", { check: true })).status).toBe(1);

    write("examples/c/telo.yaml", application({ Run: "../../modules/run" }));
    expect((await run([file], "relative", { check: true })).status).toBeUndefined();
  });

  it("--dry-run shows the rewrite, writes nothing and exits as the write would", async () => {
    const file = write("examples/d/telo.yaml", application({ Run: runPin }));

    const { envelope, status } = await run([file], "relative", { dryRun: true });

    expect(status).toBeUndefined();
    expect(envelope).toMatchObject({ dryRun: true, rewritten: [{ to: "../../modules/run" }] });
    expect(fs.readFileSync(file, "utf8")).toBe(application({ Run: runPin }));
  });
});

describe("telo upgrade --pin-local", () => {
  it("runs telo release imports --as=published on the named manifests and names the replacement", async () => {
    const file = write("examples/e/telo.yaml", application({ Run: "../../modules/run" }));
    published("run", ["0.2.7"]);
    const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
    const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
    const restore = installOutput(new Output({ format: "json", stdout, stderr, env: {} }));
    try {
      await upgrade({ paths: [file], includePrerelease: false, dryRun: false, pinLocal: true });
    } finally {
      restore();
    }

    expect(fs.readFileSync(file, "utf8")).toBe(application({ Run: runPin }));
    expect(JSON.parse(stdout.text).repins).toEqual([
      expect.objectContaining({ source: "../../modules/run", to: `${REGISTRY}/run@0.2.7` }),
    ]);
    expect(stderr.text).toContain("`telo release imports --as=published` on the same manifests instead");
  });
});

describe("usage", () => {
  it.each([
    [[], /Missing required argument: as/],
    [["--as", "pinned"], /Invalid values:[\s\S]*Argument: as, Given: "pinned"/],
  ])("refuses %j with exit 2", (flags, reason) => {
    const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
    const restore = installOutput(
      new Output({ format: "text", stdout: { write: () => {} }, stderr, env: {} }),
    );
    try {
      parseCommandLine(releaseCommand(yargs(["release", "imports", "x.yaml", ...flags])));
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    expect(stderr.text).toMatch(reason);
  });
});
