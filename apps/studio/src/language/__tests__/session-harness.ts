import type { CachedEngine, EngineCache } from "@telorun/language-host";
import type { WorkspaceAdapter } from "../../model";
import { LanguageSession, type LanguageSessionOptions } from "../language-session";
import { MemoryStorage } from "./fake-engine";

const sessions: LanguageSession[] = [];

const emptyWorkspace: WorkspaceAdapter = {
  readFile: async (path) => {
    throw new Error(`no file ${path}`);
  },
  readBytes: async (path) => {
    throw new Error(`no file ${path}`);
  },
  writeFile: async () => undefined,
  listDir: async () => [],
  createDir: async () => undefined,
  delete: async () => undefined,
  rename: async () => undefined,
};

export function memoryEngineCache(): EngineCache {
  const entries = new Map<string, CachedEngine>();
  return {
    get: async (version) => entries.get(version),
    put: async (version, engine) => void entries.set(version, engine),
    has: async (version) => entries.has(version),
  };
}

/** A session over an empty workspace rooted at `/ws`, offline; stopped by
 *  {@link stopSessions}. */
export async function startSession(
  overrides: Partial<LanguageSessionOptions> & Pick<LanguageSessionOptions, "monaco" | "spawner">,
): Promise<LanguageSession> {
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

export async function stopSessions(): Promise<void> {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
