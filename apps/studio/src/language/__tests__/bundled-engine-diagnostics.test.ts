// @vitest-environment node
import type { CachedEngine, EngineSpawner } from "@telorun/language-host";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, expect, it, vi } from "vitest";
import { TauriFsAdapter } from "../../loader/adapters/tauri-fs";
import type { ModuleDocument } from "../../model";
import { emptyDiagnostics, withPublishedDiagnostics, type WorkspaceDiagnostics } from "../engine-diagnostics";
import { LanguageSession } from "../language-session";
import { WorkspaceModels } from "../workspace-models";
import { fakeMonaco } from "./fake-monaco";
import { MemoryStorage } from "./fake-engine";

/**
 * Studio's analysis path below the UI — Monaco models, the LSP bridge, the
 * router, the desktop workspace adapter serving the engine's reads, and the
 * bundled engine file in a worker — shows the diagnostics `telo check -o json`
 * reports, including one in an imported library no editor has open.
 */

vi.mock("@tauri-apps/plugin-fs", async () => {
  const fs = await import("node:fs/promises");
  const exists = (path: string) => fs.stat(path).then(() => true, () => false);
  return {
    readTextFile: (path: string) => fs.readFile(path, "utf8"),
    exists,
    stat: async (path: string) => ({ isDirectory: (await fs.stat(path)).isDirectory() }),
    readDir: async (path: string) =>
      (await fs.readdir(path, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
      })),
  };
});

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = "tests/__fixtures__/library-variables/typo-app.yaml";
const engineDir = dirname(createRequire(import.meta.url).resolve("@telorun/language-server/package.json"));

/** The Web Worker spawner's stand-in: the same verified bytes, run as a module
 *  in a `worker_threads` worker whose port is adapted to the engine's. */
const workers: Worker[] = [];
const workerSpawner: EngineSpawner = {
  spawn: ({ bytes }) => {
    const engine = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
    const bootstrap = [
      `import { parentPort } from "node:worker_threads";`,
      `const { serve } = await import(${JSON.stringify(engine)});`,
      `serve({ postMessage: (m) => parentPort.postMessage(m), addEventListener: (t, l) => parentPort.on("message", (data) => l({ data })) });`,
    ].join("\n");
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
    workers.push(worker);
    return {
      port: {
        postMessage: (message) => worker.postMessage(message),
        addEventListener: (type, listener) => worker.on("message", (data) => listener({ data })),
      },
      onFailure: (listener) => worker.on("error", (error) => listener(error.message)),
      terminate: () => void worker.terminate(),
    };
  },
};

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

function teloCheck(entry: string): string[] {
  const run = spawnSync(
    join(REPO, "node_modules", ".bin", "bun"),
    [join(REPO, "cli", "nodejs", "bin", "telo.ts"), "-o", "json", "check", "--no-cache-write", entry],
    { cwd: REPO, encoding: "utf8" },
  );
  if (!run.stdout) throw new Error(`telo check produced no payload: ${run.stderr}`);
  return JSON.parse(run.stdout).diagnostics.map(
    (d: { file: string; line: number; column: number; severity: string; code?: string }) =>
      `${d.file}:${d.line}:${d.column} ${d.severity} ${d.code ?? ""}`,
  );
}

function rows(store: WorkspaceDiagnostics): string[] {
  const all = [
    ...[...store.byResource].flatMap(([file, byName]) => [...byName.values()].flat().map((d) => ({ file, d }))),
    ...[...store.byFile].flatMap(([file, list]) => list.map((d) => ({ file, d }))),
  ];
  return all
    .map(
      ({ file, d }) =>
        `${relative(REPO, file)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
        `${d.severity === 1 ? "error" : "warning"} ${d.code}`,
    )
    .sort();
}

it("shows the diagnostics telo check reports, from the bundled engine", async () => {
  const expected = teloCheck(ENTRY).sort();
  expect(expected.length).toBeGreaterThan(0);

  let store = emptyDiagnostics();
  const engines = new Map<string, CachedEngine>();
  const { monaco } = fakeMonaco();
  const session = await LanguageSession.start({
    monaco,
    rootDir: REPO,
    workspace: () => new TauriFsAdapter(),
    hubUrl: () => "http://127.0.0.1:9",
    manifestSources: () => [],
    spawner: workerSpawner,
    engineCache: {
      get: async (version) => engines.get(version),
      put: async (version, engine) => void engines.set(version, engine),
      has: async (version) => engines.has(version),
    },
    bundled: { load: async () => new Uint8Array(readFileSync(join(engineDir, "dist", "language-server.mjs"))) },
    storage: new MemoryStorage(),
    fetch: async () => {
      throw new TypeError("offline in this test");
    },
    onDiagnostics: (uri, diagnostics) => {
      store = withPublishedDiagnostics(store, uri, diagnostics);
    },
    onMessage: () => undefined,
  });

  const entry = join(REPO, ENTRY);
  const models = new WorkspaceModels(monaco);
  models.sync(new Map([[entry, { loaded: { text: readFileSync(entry, "utf8") } } as unknown as ModuleDocument]]));

  const deadline = Date.now() + 60_000;
  while (rows(store).join("\n") !== expected.join("\n") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await session.dispose();
  models.dispose();

  expect(rows(store)).toEqual(expected);
}, 120_000);
