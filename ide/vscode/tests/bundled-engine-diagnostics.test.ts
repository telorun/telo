import { HubClient, LanguageRouter, createInProcessTransports } from "@telorun/language-host";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { createMessageConnection } from "vscode-languageserver-protocol";
import { FileEngineCache } from "../src/file-engine-cache.js";
import { kernelRemoteReader } from "../src/kernel-remote-reader.js";
import { NodeAdapter } from "../src/node-adapter.js";
import { nodeEngineSpawner } from "../src/node-engine-spawner.js";

/**
 * The extension's wiring below the VS Code UI — the router, the worker_threads
 * spawner, the NodeAdapter-backed host services and the bundled engine file —
 * publishes the diagnostics `telo check -o json` reports.
 */

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const engineDir = dirname(createRequire(import.meta.url).resolve("@telorun/language-server/package.json"));
const cacheDir = mkdtempSync(join(tmpdir(), "telo-vscode-engines-"));

// An `include:` glob reaching into `node_modules` and across a symbolic link:
// the engine expands it itself over `telo/listDirectory`, and must prune exactly
// what the kernel prunes and skip what it skips — a linked partial is not a
// regular file. (A linked DIRECTORY is not walked either; that is proven in the
// engine's own tests, because the `telo check` below runs under Bun, whose
// recursive `readdir` follows it where Node's does not.) Built on disk per run,
// since `node_modules` and links are never committed. `!telo.yaml` keeps the
// owner out of its own partials, which a bare `**` would pull in and refuse.
const globDir = mkdtempSync(join(tmpdir(), "telo-vscode-include-"));
const elsewhere = mkdtempSync(join(tmpdir(), "telo-vscode-linked-"));
mkdirSync(join(globDir, "node_modules"));
mkdirSync(join(globDir, "routes"));
writeFileSync(join(elsewhere, "linked.yaml"), "kind: Linked.Thing\nmetadata:\n  name: linked\n");
symlinkSync(join(elsewhere, "linked.yaml"), join(globDir, "routes", "linked.yaml"));
writeFileSync(
  join(globDir, "telo.yaml"),
  'kind: Telo.Application\nmetadata:\n  name: IncludeAll\n  version: 1.0.0\ninclude:\n  - "**"\n  - "!telo.yaml"\n',
);
writeFileSync(join(globDir, "routes", "partial.yaml"), "kind: Nope.Thing\nmetadata:\n  name: routed\n");
writeFileSync(join(globDir, "node_modules", "x.yaml"), "kind: Hidden.Thing\nmetadata:\n  name: hidden\n");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(globDir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

const ENTRIES = [
  "tests/__fixtures__/cel-typing-gaps.yaml",
  "tests/__fixtures__/extends-unknown-target.yaml",
  "tests/__fixtures__/library-variables/typo-app.yaml",
  "tests/__fixtures__/base-mismatch/telo.yaml",
  "tests/__fixtures__/stream-argument-mismatch.yaml",
  relative(REPO, join(globDir, "telo.yaml")),
];

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

it.each(ENTRIES)("the bundled engine reports what telo check reports for %s", async (entry) => {
  const transports = createInProcessTransports();
  const engines = new FileEngineCache(cacheDir);
  const router = new LanguageRouter({
    client: transports.server,
    files: new NodeAdapter(),
    remote: kernelRemoteReader(),
    hub: new HubClient({ url: () => "http://127.0.0.1:9" }),
    resolutions: { read: async () => undefined, write: async () => undefined },
    spawner: nodeEngineSpawner,
    engineCache: engines,
    catalogCache: engines,
    bundled: { load: async () => new Uint8Array(readFileSync(join(engineDir, "dist", "language-server.mjs"))) },
    fetch: async () => {
      throw new TypeError("offline in this test");
    },
  });
  const client = createMessageConnection(transports.client.reader, transports.client.writer);
  const published = new Map<string, Array<{ range: any; severity: number; code?: string }>>();
  client.onNotification("textDocument/publishDiagnostics", (params: any) =>
    published.set(fileURLToPath(params.uri), params.diagnostics),
  );
  client.onNotification("window/logMessage", () => undefined);
  client.onRequest("client/registerCapability", () => null);
  client.listen();

  await client.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
  await client.sendNotification("initialized", {});
  const path = join(REPO, entry);
  await client.sendNotification("textDocument/didOpen", {
    textDocument: { uri: pathToFileURL(path).href, languageId: "telo", version: 1, text: readFileSync(path, "utf8") },
  });
  const deadline = Date.now() + 60_000;
  while (!published.has(path)) {
    if (Date.now() > deadline) throw new Error(`no diagnostics published for ${entry}`);
    await new Promise((r) => setTimeout(r, 20));
  }

  const rows = [...published].flatMap(([file, list]) =>
    list.map(
      (d) =>
        `${relative(REPO, file)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
        `${d.severity === 1 ? "error" : "warning"} ${d.code ?? ""}`,
    ),
  );
  await client.sendRequest("shutdown");
  await client.sendNotification("exit");
  client.dispose();

  expect(router.status().error).toBeUndefined();
  expect(rows.sort()).toEqual(teloCheck(entry).sort());
});
