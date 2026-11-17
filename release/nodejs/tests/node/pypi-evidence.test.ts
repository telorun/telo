import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LEDGER, SHIPPED_ADAPTERS } from "../../src/index.js";
import { digestFileSet, listFiles, readFileSetEntry } from "../../src/node/files-digest.js";
import { isolatedSdistBuilder, pypiEvidenceWith, type SdistBuilder } from "../../src/node/adapters/pypi-evidence.js";
import { PYPI_BUILD_SDIST_SCRIPT } from "../../src/node/adapters/pypi-build-sdist.js";
import { loadReleaseWorkspace } from "../../src/node/workspace.js";
import { commit, has, host, read, run, tempRepo, write } from "./fixture.js";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  vi.unstubAllGlobals();
});

function repo(files: Record<string, string>): string {
  const root = tempRepo(files);
  roots.push(root);
  return root;
}

/** Stands in for a backend: every file of the project, plus the metadata a backend derives. */
const fakeBuilder =
  (fail?: (projectDir: string) => boolean): SdistBuilder =>
  async (projectDir, system, where) => {
    if (fail?.(projectDir)) throw new Error(`${where}: the backend failed`);
    return [
      ...listFiles(projectDir, new Set()).map((file) => readFileSetEntry(projectDir, file)),
      { path: "PKG-INFO", content: Buffer.from(`Metadata-Version: 2.4\nBackend: ${system.backend}\n`) },
      { path: "src/acme_api.egg-info/SOURCES.txt", content: Buffer.from("x\n") },
    ];
  };

const API = '[project]\nname = "Acme.API"\nversion = "1.0.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n';
const WORKER =
  '[project]\nname = "worker"\nversion = "0.3.0"\ndependencies = [\n  "acme-api>=1.0.0",\n  "acme_api[x] >=1.0, <2",\n  "requests>=2",\n]\n\n' +
  '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.uv.sources]\nacme-api = { workspace = true }\n';
const UV_LOCK =
  'version = 1\n\n[[package]]\nname = "acme-api"\nversion = "1.0.0"\nsource = { editable = "apps/api" }\n\n' +
  '[[package]]\nname = "requests"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }\n\n' +
  '[[package]]\nname = "worker"\nversion = "0.3.0"\nsource = { editable = "apps/worker" }\n';

function workspace(marker = "release:\n  units:\n    - { path: apps/api, ecosystem: pypi }\n    - { path: apps/worker, ecosystem: pypi }\n") {
  return {
    "telo-workspace.yaml": marker,
    "apps/api/pyproject.toml": API,
    "apps/api/src/acme_api/__init__.py": "x = 1\n",
    "apps/worker/pyproject.toml": WORKER,
    "apps/worker/src/worker/__init__.py": "y = 1\n",
    "uv.lock": UV_LOCK,
  };
}

async function session(root: string, builder: SdistBuilder, key: string) {
  const ws = loadReleaseWorkspace(root, { adapters: SHIPPED_ADAPTERS });
  const unit = ws.units.find((u) => u.key === key)!;
  const anchor = unit.anchors[0]!;
  const opened = await pypiEvidenceWith({ buildSdist: builder }).open(ws, { ledger: EMPTY_LEDGER, argv: {} });
  return { session: opened, ref: { unit, anchor } };
}

function sdist(top: string, files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`${top}/${name}`, 0);
    header.write("0000644\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("pypi evidence", () => {
  it("digests the sdist's members less the metadata its backend derives", async () => {
    const root = repo(workspace());
    const { session: s, ref } = await session(root, fakeBuilder(), "apps/api");
    const found = await s.collect(ref);
    const dir = path.join(root, "apps/api");
    expect(found.layer).toBe(digestFileSet(listFiles(dir, new Set()).map((file) => readFileSetEntry(dir, file))));
    expect(found.files).toEqual(["apps/api/pyproject.toml", "apps/api/src/acme_api/__init__.py"]);
  });

  it("plans a dependent with its sibling, and moves its linked requirement and the lockfile on apply", async () => {
    const root = repo(workspace());
    const evidence = [pypiEvidenceWith({ buildSdist: fakeBuilder() })];
    const { host: h, recorded } = host({ evidence });
    expect((await run(h, recorded, root, ["baseline"])).exitCode).toBe(0);
    commit(root, "baseline");
    write(root, { ".changes/pending/added-x.yaml": "units: { apps/api: Added }\nbody: A thing.\n" });
    commit(root, "fragment");

    const status = await run(h, recorded, root, ["status", "--base", "HEAD", "-o", "json"]);
    expect((status.payload.units as { key: string; reasons: unknown[] }[]).map((u) => [u.key, u.reasons])).toEqual([
      ["apps/api", ["declared"]],
      ["apps/worker", ["imports apps/api"]],
    ]);
    expect((await run(h, recorded, root, ["apply", "--base", "HEAD"])).exitCode).toBe(0);
    expect(read(root, "apps/worker/pyproject.toml")).toBe(
      WORKER.replace('version = "0.3.0"', 'version = "0.4.0"').replace('"acme-api>=1.0.0"', '"acme-api>=1.1.0"'),
    );
    expect(read(root, "uv.lock")).toBe(UV_LOCK.replace('version = "1.0.0"\nsource = { editable', 'version = "1.1.0"\nsource = { editable').replace('"0.3.0"', '"0.4.0"'));
  });

  it("restores the lockfile and every pyproject when the apply fails after moving them", async () => {
    const root = repo({
      ...workspace(),
      ".changes/ledger.yaml": "units:\n  apps/api: { version: 1.0.0, layers: { pypi: { .: sha256-old } } }\n",
      ".changes/pending/fixed-x.yaml": "units: { apps/api: Fixed }\nbody: A fix.\n",
    });
    // The second reading of the api, taken once the versions are written, fails.
    const evidence = [pypiEvidenceWith({ buildSdist: fakeBuilder((dir) => fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8").includes("1.0.1")) })];
    const { host: h, recorded } = host({ evidence });
    expect((await run(h, recorded, root, ["apply", "--base", "HEAD"])).exitCode).toBe(1);
    expect(recorded.stderr.join("\n")).toMatch(/the backend failed[\s\S]*The apply was undone/);
    expect(read(root, "uv.lock")).toBe(UV_LOCK);
    expect(read(root, "apps/worker/pyproject.toml")).toBe(WORKER);
    expect(read(root, "apps/api/pyproject.toml")).toBe(API);
  });

  it("refuses a candidate PEP 440 cannot spell, writing nothing", async () => {
    const root = repo({ ...workspace(), ".changes/pending/fixed-x.yaml": "units: { apps/api: Fixed }\nbody: A fix.\n" });
    const { host: h, recorded } = host({ evidence: [pypiEvidenceWith({ buildSdist: fakeBuilder() })] });
    expect((await run(h, recorded, root, ["apply", "--candidate=next", "--base", "HEAD"])).exitCode).toBe(1);
    expect(recorded.stderr.join("\n")).toMatch(/not a version PEP 440 can spell/);
    expect(read(root, "apps/api/pyproject.toml")).toBe(API);
    expect(read(root, "apps/worker/pyproject.toml")).toBe(WORKER);
  });

  it("reads a version back from the simple index in PEP 440 form, absent where the index serves none", async () => {
    const marker =
      "release:\n  ecosystems: { pypi: { registry: https://index.example/simple/ } }\n  units:\n    - { path: apps/api, ecosystem: pypi }\n    - { path: apps/worker, ecosystem: pypi }\n";
    const root = repo(workspace(marker));
    const files = { "pyproject.toml": API, "src/acme_api/__init__.py": "x = 1\n", "PKG-INFO": "Metadata-Version: 2.1\n" };
    const bytes = sdist("acme_api-1.0.0rc1", files);
    const pages: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      pages.push(`${url} ${init.headers.accept}`);
      if (url === "https://index.example/simple/acme-api/") {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const listed = [{ filename: "acme_api-1.0.0rc1.tar.gz", url: "../../files/acme_api-1.0.0rc1.tar.gz", hashes: { sha256 } }];
        return new Response(JSON.stringify({ meta: { "api-version": "1.0" }, files: listed }), {
          headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
        });
      }
      return url === "https://index.example/files/acme_api-1.0.0rc1.tar.gz" ? new Response(bytes) : new Response("", { status: 404 });
    });
    const { session: s, ref } = await session(root, fakeBuilder(), "apps/api");
    expect(s.destination!(ref)).toBe("https://index.example/simple/acme-api");
    const local = digestFileSet([
      { path: "pyproject.toml", content: Buffer.from(API) },
      { path: "src/acme_api/__init__.py", content: Buffer.from("x = 1\n") },
    ]);
    expect(await s.readBack!(ref, "1.0.0-rc.1", local)).toEqual({ kind: "published", layer: local, drift: [] });
    expect(await s.readBack!(ref, "1.0.0", undefined)).toEqual({ kind: "absent" });
    expect(await s.publishedVersions!(ref)).toEqual(["1.0.0rc1"]);
    expect(pages[0]).toBe("https://index.example/simple/acme-api/ application/vnd.pypi.simple.v1+json, text/html;q=0.1");
    const worker = await session(root, fakeBuilder(), "apps/worker");
    expect(await worker.session.readBack!(worker.ref, "0.3.0", undefined)).toEqual({ kind: "absent" });
  });

  it("carries the frontend's bytes, which the Rust twin embeds from the .py file", () => {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/node/adapters/pypi-build-sdist.py");
    expect(PYPI_BUILD_SDIST_SCRIPT).toBe(fs.readFileSync(file, "utf8"));
  });
});

/** Whether a fresh venv can install setuptools — Python 3 with venv, and an index or pip's cache. */
function canBuild(): boolean {
  if (has("python3", ["-c", "import venv, ensurepip"]) === undefined) return false;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telorun-release-pypi-probe-"));
  try {
    execFileSync("python3", ["-I", "-m", "pip", "download", "--no-deps", "--quiet", "--disable-pip-version-check", "-d", scratch, "setuptools>=61"], {
      stdio: "ignore",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

describe.skipIf(!canBuild())("pypi evidence over a real backend (needs python3 with venv, and setuptools from an index or pip's cache)", () => {
  it("builds the sdist setuptools makes in an isolated environment and leaves the project as it was", async () => {
    const root = repo({
      "telo-workspace.yaml": "release:\n  units:\n    - { path: apps/api, ecosystem: pypi }\n",
      "apps/api/pyproject.toml":
        '[project]\nname = "acme-api"\nversion = "1.0.0"\n\n[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "setuptools.build_meta"\n',
      "apps/api/src/acme_api/__init__.py": "x = 1\n",
      "apps/api/notes.txt": "not packaged\n",
    });
    const { session: s, ref } = await session(root, isolatedSdistBuilder, "apps/api");
    const before = listFiles(root, new Set([".git"]));
    const found = await s.collect(ref);
    expect(found.files).toEqual(expect.arrayContaining(["apps/api/pyproject.toml", "apps/api/src/acme_api/__init__.py"]));
    expect(found.files).not.toContain("apps/api/notes.txt");
    expect(listFiles(root, new Set([".git"]))).toEqual(before);
    expect((await s.collect(ref)).layer).toBe(found.layer);
  }, 300_000);
});

