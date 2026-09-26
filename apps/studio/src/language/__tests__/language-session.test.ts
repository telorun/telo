import { sha512Integrity, type CachedEngine, type EngineCache } from "@telorun/language-host";
import { afterEach, expect, it } from "vitest";
import type { WorkspaceAdapter } from "../../model";
import { LanguageSession, type LanguageSessionOptions } from "../language-session";
import { writeTeloVersionSetting } from "../language-storage";
import { fakeEngineSpawner, MemoryStorage } from "./fake-engine";
import { fakeMonaco } from "./fake-monaco";
import { ModelProjections } from "../model-projections";

const OTHER = "0.200.0";
const sessions: LanguageSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
});

const emptyWorkspace: WorkspaceAdapter = {
  readFile: async (path) => {
    throw new Error(`no file ${path}`);
  },
  writeFile: async () => undefined,
  listDir: async () => [],
  createDir: async () => undefined,
  delete: async () => undefined,
  rename: async () => undefined,
};

function memoryEngineCache(): EngineCache {
  const entries = new Map<string, CachedEngine>();
  return {
    get: async (version) => entries.get(version),
    put: async (version, engine) => void entries.set(version, engine),
    has: async (version) => entries.has(version),
  };
}

async function start(overrides: Partial<LanguageSessionOptions> & Pick<LanguageSessionOptions, "monaco" | "spawner">) {
  const session = await LanguageSession.start({
    rootDir: "/ws",
    workspace: () => emptyWorkspace,
    confineTo: "/ws",
    hubUrl: () => "http://127.0.0.1:9",
    manifestSources: () => [],
    engineCache: memoryEngineCache(),
    bundled: { load: async () => new Uint8Array() },
    storage: new MemoryStorage(),
    fetch: async () => {
      throw new TypeError("offline in this test");
    },
    onDiagnostics: () => undefined,
    onMessage: () => undefined,
    ...overrides,
  });
  sessions.push(session);
  return session;
}

it("registers a Monaco feature only for what the engine advertised", async () => {
  const { monaco, registered, commands } = fakeMonaco();
  const { spawner } = fakeEngineSpawner({ textDocumentSync: 1, hoverProvider: true, codeLensProvider: {} });
  await start({ monaco, spawner });
  await until(() => registered.length === 2, "the registrations");
  expect([...registered].sort()).toEqual(["codeLens", "hover"]);
  expect([...commands.keys()]).toEqual([]);
});

/** A session whose registry offers OTHER, already cached, with the
 *  workspace's telo version setting pinned to `pin`. */
async function sessionOffering(
  options: Pick<LanguageSessionOptions, "monaco" | "spawner">,
  pin: string | undefined,
) {
  const engine = new TextEncoder().encode("export function serve() {}");
  const engineCache = memoryEngineCache();
  await engineCache.put(OTHER, { bytes: engine, digest: await sha512Integrity(engine) });
  const registryDocument = {
    versions: {
      [OTHER]: {
        teloEditorProtocol: 1,
        dist: { tarball: `https://registry.invalid/${OTHER}.tgz`, integrity: "sha512-unused" },
      },
    },
  };
  const storage = new MemoryStorage();
  if (pin) writeTeloVersionSetting("/ws", pin, storage);
  return start({
    ...options,
    engineCache,
    storage,
    fetch: async () => new Response(JSON.stringify(registryDocument), { status: 200 }),
  });
}

it("runs every module on the version the workspace's telo version setting pins", async () => {
  const { monaco } = fakeMonaco();
  const { spawner, spawned } = fakeEngineSpawner({ textDocumentSync: 1 });
  const session = await sessionOffering({ monaco, spawner }, OTHER);
  monaco.editor.createModel("kind: Telo.Application\n", "yaml", monaco.Uri.parse("file:///ws/app/telo.yaml"));
  session.setActiveDocument("/ws/app/telo.yaml");

  const deadline = Date.now() + 5_000;
  while (!spawned.includes(OTHER) || session.status().version !== OTHER) {
    if (Date.now() > deadline) throw new Error(`never moved to ${OTHER}: spawned ${spawned.join(", ")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(session.status()).toMatchObject({ version: OTHER, pinned: true });
  expect(session.teloVersion).toBe(OTHER);
});

// The router registers the union of its running engines' features and
// re-registers it as engines come and go; the bridge's providers follow.
it("offers a feature while an engine advertising it runs, and withdraws it when that engine stops", async () => {
  const { monaco, registered } = fakeMonaco();
  const { spawner } = fakeEngineSpawner((version) =>
    version === OTHER ? { textDocumentSync: 1, completionProvider: {} } : { textDocumentSync: 1, hoverProvider: true },
  );
  const session = await sessionOffering({ monaco, spawner }, OTHER);
  monaco.editor.createModel("kind: Telo.Application\n", "yaml", monaco.Uri.parse("file:///ws/app/telo.yaml"));
  await until(() => registered.includes("completion") && registered.includes("hover"), "the union");

  await session.setTeloVersion("auto");
  await until(() => !registered.includes("completion"), "the withdrawal");
  expect(registered).toEqual(["hover"]);
});

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

it("serves a projected model through its source document, never opening it", async () => {
  const { monaco, providers } = fakeMonaco();
  const edit = (line: number, character: number, newText: string) => ({
    label: newText,
    textEdit: { range: { start: { line, character }, end: { line, character: character + 3 } }, newText },
  });
  const { spawner, received } = fakeEngineSpawner(
    { textDocumentSync: 1, completionProvider: {} },
    { "textDocument/completion": () => [edit(5, 6, "inside"), edit(0, 0, "outside")] },
  );
  const projections = new ModelProjections("projection");
  await start({ monaco, spawner, projections });

  const source = "file:///ws/app/telo.yaml";
  monaco.editor.createModel("a\nb\nc\nd\ne\nf\ng\n", "yaml", monaco.Uri.parse(source));
  const projected = monaco.editor.createModel("x\ny\nz\n", "yaml", monaco.Uri.parse("projection:///1/ws/app/telo.yaml"));
  // Lines 4–6 of the source, two columns in.
  projections.add({
    model: projected,
    source,
    toSource: (p) => ({ line: p.line + 4, character: p.character + 2 }),
    fromSource: (p) => (p.line >= 4 && p.line <= 6 ? { line: p.line - 4, character: p.character - 2 } : undefined),
  });
  await until(() => received.some((m) => m.method === "textDocument/didOpen"), "the source to open");

  const result = await providers
    .get("completion")!
    .provider.provideCompletionItems(projected, { lineNumber: 2, column: 5 }, { triggerKind: 0 }, token);

  expect(received.find((m) => m.method === "textDocument/completion")?.params).toMatchObject({
    textDocument: { uri: source },
    position: { line: 5, character: 6 },
  });
  expect(result.suggestions.map((s: { label: string; range: unknown }) => [s.label, s.range])).toEqual([
    ["inside", { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 8 }],
  ]);
  expect(received.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument.uri)).toEqual([
    source,
  ]);
});

it("serves nothing to a model outside the manifest documents, and never opens it", async () => {
  const { monaco, providers } = fakeMonaco();
  const { spawner, received } = fakeEngineSpawner({ textDocumentSync: 1, completionProvider: {}, hoverProvider: true });
  await start({ monaco, spawner, projections: new ModelProjections("projection") });

  // A non-manifest `.yaml` file as the raw file editor holds it.
  monaco.editor.createModel("key: value\n", "yaml", monaco.Uri.parse("inmemory://model/1"));
  monaco.editor.createModel("kind: Telo.Application\n", "yaml", monaco.Uri.parse("file:///ws/app/telo.yaml"));
  await until(() => received.some((m) => m.method === "textDocument/didOpen"), "the manifest to open");

  const opened = received.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument.uri);
  expect(opened).toEqual(["file:///ws/app/telo.yaml"]);
  const selects = (selector: unknown) =>
    (selector as Array<{ language: string; scheme: string }>).some((f) => f.language === "yaml" && f.scheme === "inmemory");
  expect([...providers.values()].filter((p) => selects(p.selector))).toEqual([]);
  expect(providers.size).toBe(2);
});
