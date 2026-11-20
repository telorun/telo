import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publish } from "../src/commands/publish.js";
import { Output, installOutput } from "../src/output.js";
import { FakeGitHost, fakeHistory } from "./__fixtures__/commit-history/fake-git-host.js";

const history = fakeHistory();
const host = new FakeGitHost(history.all, { "refs/heads/main": { id: history.head.id } });
const elsewhere: string[] = [];
let dir: string;

beforeAll(async () => {
  await host.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-publish-revisions-"));
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://git.test/")) return host.fetch(input, init);
    elsewhere.push(url);
    return realFetch("http://127.0.0.1:9/", init);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  await host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

function library(revision: string): string {
  const file = path.join(dir, "telo.yaml");
  fs.writeFileSync(path.join(dir, "NOTICE"), "notice\n");
  fs.writeFileSync(
    file,
    [
      "kind: Telo.Library",
      "metadata: { name: Embedded, version: 1.0.0 }",
      "sources:",
      "  addon:",
      "    version: 1.0.0",
      "    purl: pkg:npm/addon",
      "    contains:",
      "      - purl: pkg:generic/engine",
      "        version: 5.3.0",
      "        vcs:",
      "          url: git+https://git.test/acme/repo",
      `          revision: ${revision}`,
      "    url: https://example.test/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries: {}",
      "",
    ].join("\n"),
  );
  return file;
}

async function publishJson(file: string) {
  let stdout = "";
  let stderr = "";
  const restore = installOutput(
    new Output({
      format: "json",
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
      env: {},
    }),
  );
  try {
    await publish({ paths: ["oci://registry.example/acme/embedded", file], dryRun: false, skipControllers: true });
  } finally {
    restore();
  }
  const exit = Number(process.exitCode ?? 0);
  return { exit, json: JSON.parse(stdout), stderr };
}

describe("telo publish and declared revisions", () => {
  it("refuses a commit no branch or tag of the named repository reaches, and pushes nothing", async () => {
    host.mode = "ok";
    const { exit, json, stderr } = await publishJson(library(history.fork.id));
    expect(exit).toBe(1);
    expect(json.modules[0].error.code).toBe("manifest_invalid");
    expect(json.modules[0].error.details.diagnostics).toEqual([
      expect.objectContaining({
        line: 12,
        code: "SOURCE_REVISION_UNREACHABLE",
        message:
          `sources.addon.contains[0].vcs.revision ${history.fork.id} is not reachable from any branch or tag of ` +
          "https://git.test/acme/repo. Write the commit the staged files were built from, and the repository whose history holds it.",
      }),
    ]);
    expect(stderr).toContain("SOURCE_REVISION_UNREACHABLE");
    expect(elsewhere).toEqual([]);
  });

  it("refuses a repository its host gives no history of, naming the host and the cause", async () => {
    host.mode = "version-0";
    const { exit, json } = await publishJson(library(history.head.id));
    expect(exit).toBe(1);
    expect(json.modules[0].error.code).toBe("source_repository_unreadable");
    const [diagnostic] = json.modules[0].error.details.diagnostics;
    expect(diagnostic.code).toBe("SOURCE_REPOSITORY_UNREADABLE");
    expect(diagnostic.message).toContain("git.test gave no history of https://git.test/acme/repo");
    expect(diagnostic.message).toContain("does not speak version 2 of git's protocol");
    expect(diagnostic.message).toContain("or remove vcs to leave the component unchecked");
    expect(elsewhere).toEqual([]);
  });
});
