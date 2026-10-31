import { createInProcessTransports, type EngineSpawner } from "@telorun/language-host";
import {
  createMessageConnection,
  type MessageConnection,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";

/** Engines that run in this process, each advertising `capabilities` (or its
 *  version's, `experimental.telo` beside the protocol generation) and
 *  answering the requests in `handlers`; the bundled one (spawned with no
 *  version) names itself `bundled`. `spawned` records every version started,
 *  `received` every message an engine was sent; `notify` sends a notification
 *  from every engine started. */
export function fakeEngineSpawner(
  capabilities: ServerCapabilities | ((version: string) => ServerCapabilities),
  handlers: Record<string, (params: any) => unknown> = {},
  bundled = "0.101.0",
): {
  spawner: EngineSpawner;
  spawned: string[];
  received: Array<{ method: string; params: any }>;
  notify(method: string, params: unknown): Promise<void>;
} {
  const spawned: string[] = [];
  const received: Array<{ method: string; params: any }> = [];
  const engines: MessageConnection[] = [];
  return {
    spawned,
    received,
    notify: async (method, params) => {
      await Promise.all(engines.map((engine) => engine.sendNotification(method, params)));
    },
    spawner: {
      spawn: (spawn) => {
        const version = spawn.version ?? bundled;
        spawned.push(version);
        const { client, server } = createInProcessTransports();
        const engine = createMessageConnection(server.reader, server.writer);
        engine.onRequest("initialize", () => {
          const advertised = typeof capabilities === "function" ? capabilities(version) : capabilities;
          return {
            capabilities: {
              ...advertised,
              experimental: { telo: { ...advertised.experimental?.telo, protocol: 2 } },
            },
            serverInfo: { name: "telo", version },
          };
        });
        engine.onRequest("shutdown", () => null);
        for (const [method, handler] of Object.entries(handlers)) {
          engine.onRequest(method, (params: unknown) => {
            received.push({ method, params });
            return handler(params);
          });
        }
        engine.onNotification((method: string, params: unknown) => void received.push({ method, params }));
        engine.listen();
        engines.push(engine);
        return {
          port: {
            postMessage: (message) => void client.writer.write(message as never),
            addEventListener: (type, listener) => client.reader.listen((message) => listener({ data: message })),
          },
          onFailure: () => undefined,
          terminate: () => {
            engines.splice(engines.indexOf(engine), 1);
            engine.dispose();
          },
        };
      },
    },
  };
}

/** `Storage` in memory, for the settings and stores a session keeps. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}
