import { HubClient, LanguageRouter, createInProcessTransports } from "@telorun/language-host";
import { expect, it } from "vitest";
import { createMessageConnection } from "vscode-languageserver-protocol";
import { NodeAdapter } from "../src/node-adapter.js";
import { nodeEngineSpawner } from "../src/node-engine-spawner.js";

/**
 * The extension's activation awaits `initialize`: an engine module that throws
 * while evaluating in its worker is reported by the worker_threads spawner, so
 * `initialize` is still answered and the status names the failure.
 */
it("answers initialize and reports the failure when the bundled engine throws while loading", async () => {
  const transports = createInProcessTransports();
  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  const router = new LanguageRouter({
    client: transports.server,
    files: new NodeAdapter(),
    remote: unused,
    hub: new HubClient({ url: () => "http://127.0.0.1:9" }),
    resolutions: { read: async () => undefined, write: async () => undefined },
    spawner: nodeEngineSpawner,
    engineCache: { get: async () => undefined, put: unused, has: async () => false },
    catalogCache: { read: async () => undefined, write: async () => undefined },
    bundled: { load: async () => new TextEncoder().encode(`throw new Error("the engine could not evaluate");\n`) },
    fetch: async () => {
      throw new TypeError("offline in this test");
    },
  });
  const client = createMessageConnection(transports.client.reader, transports.client.writer);
  client.onNotification("window/logMessage", () => undefined);
  client.listen();

  const result: any = await client.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
  expect(result.capabilities).toEqual({ textDocumentSync: 1 });
  expect(router.status()).toMatchObject({ starting: false, error: { kind: "engine-failed" } });
  expect(router.status().error!.message).toMatch(/the engine could not evaluate/);
  client.dispose();
});
