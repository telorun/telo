/**
 * A router between a scripted editor client and scripted fake engines, all in
 * one process over the package's own transports. A fake engine is recognised by
 * the code it was spawned with — `engineCode(version, behaviour)` — so a test
 * observes exactly which version the router loaded for a document, and can make
 * an engine throw on load, never answer, or name itself wrongly.
 */

import type { RequirementsParams } from "@telorun/editor-protocol";
import {
  createMessageConnection,
  type ClientCapabilities,
  type MessageConnection,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";
import type {
  CachedEngine,
  EnginePort,
  HostFileSystem,
  RemoteReader,
  StoredResolutions,
} from "../src/host-seams.js";
import { HubClient } from "../src/hub-client.js";
import { LanguageRouter, type TeloStatus } from "../src/language-router.js";
import { createInProcessTransports } from "../src/message-transports.js";
import type { StoredCatalog } from "../src/version-catalog.js";
import { engineCode, readEngineCode } from "./registry-fixture.js";

export const BUNDLED = "0.102.0";

type Json = { id?: number; method?: string; params?: any; result?: unknown; error?: unknown };

const DEFAULT_CAPABILITIES: ServerCapabilities = { textDocumentSync: 1, hoverProvider: true };

/** A fake engine: answers initialize (with its test's capabilities) and hover,
 *  publishes what the test tells it to, and sends the `telo/requirements`
 *  scripted for each opened document. */
export class FakeEngine {
  readonly received: Json[] = [];
  private readonly listeners: Array<(event: { data: unknown }) => void> = [];
  private readonly failureListeners: Array<(reason: string) => void> = [];
  private failure: string | undefined;
  private nextId = 1000;
  private readonly pending = new Map<number, (result: unknown) => void>();
  terminated = false;

  constructor(
    readonly version: string,
    readonly behaviour: string | undefined,
    private readonly harness: RouterHarness,
  ) {}

  readonly port: EnginePort = {
    postMessage: (message) => {
      const copy = structuredClone(message) as Json;
      // The worker dies as `initialized` is being sent to it.
      if (copy.method === "initialized" && this.behaviour === "dies at initialized") {
        this.fail("the worker exited with code 1");
        return;
      }
      queueMicrotask(() => void this.receive(copy));
    },
    addEventListener: (type, listener) => void this.listeners.push(listener),
  };

  onFailure(listener: (reason: string) => void): void {
    if (this.failure !== undefined) listener(this.failure);
    else this.failureListeners.push(listener);
  }

  /** The worker dies with `reason`, as a spawner reports it. */
  fail(reason: string): void {
    if (this.failure !== undefined || this.terminated) return;
    this.failure = reason;
    for (const listener of this.failureListeners) listener(reason);
  }

  opened(): string[] {
    const open = new Set<string>();
    for (const m of this.received) {
      if (m.method === "textDocument/didOpen") open.add(m.params.textDocument.uri);
      if (m.method === "textDocument/didClose") open.delete(m.params.textDocument.uri);
    }
    return [...open];
  }

  asked(method: string): Json[] {
    return this.received.filter((m) => m.method === method);
  }

  send(message: Json): void {
    const copy = structuredClone({ jsonrpc: "2.0", ...message });
    queueMicrotask(() => this.listeners.forEach((l) => l({ data: copy })));
  }

  publish(uri: string, ...messages: string[]): void {
    this.send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: messages.map(diagnostic) } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private async receive(message: Json): Promise<void> {
    if (this.failure !== undefined || this.terminated) return;
    this.received.push(message);
    if (message.method === undefined && message.id !== undefined) {
      this.pending.get(message.id)?.(message.result);
      return;
    }
    const reply = (result: unknown) => this.send({ id: message.id, result });
    const handler = this.harness.handlers[message.method ?? ""];
    if (handler && message.id !== undefined) {
      reply(handler(this, message.params));
      return;
    }
    switch (message.method) {
      case "initialize": {
        if (this.behaviour === "silent") return;
        const reported = this.behaviour?.startsWith("reports ") ? this.behaviour.slice("reports ".length) : this.version;
        reply({
          capabilities: {
            ...(this.harness.capabilities[this.version] ?? DEFAULT_CAPABILITIES),
            experimental: { telo: { protocol: 1 } },
          },
          serverInfo: { name: "telo", version: reported },
        });
        return;
      }
      case "textDocument/didOpen": {
        const uri = message.params.textDocument.uri as string;
        this.publish(uri, `from ${this.version}`);
        const registrations = this.harness.registrationsOnOpen[this.version];
        if (registrations) void this.request("client/registerCapability", { registrations });
        const requirements = this.harness.requirements.get(uri);
        if (requirements) this.send({ method: "telo/requirements", params: requirements });
        return;
      }
      case "textDocument/hover":
        if (this.behaviour === "hangs on hover") return;
        reply({ contents: `engine ${this.version}` });
        return;
      case "workspace/executeCommand":
        reply(await this.request("workspace/applyEdit", { edit: { changes: {} } }));
        return;
      case "telo/test/read":
        reply(await this.request("telo/read", message.params));
        return;
      default:
        if (message.id !== undefined) reply(null);
    }
  }
}

export function diagnostic(message: string) {
  return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message };
}

export interface HarnessOptions {
  pin?: string;
  fetch?: typeof globalThis.fetch;
  catalog?: StoredCatalog;
  remote?: RemoteReader;
  /** The workspace's stored resolutions at start. */
  resolutions?: StoredResolutions;
  /** Engines already in the host's cache at start. */
  cached?: Record<string, CachedEngine>;
  /** The code of the engine the host ships (default: a well-behaved BUNDLED). */
  bundledCode?: string;
  /** What each engine version advertises (default: full sync and hover). */
  capabilities?: Record<string, ServerCapabilities>;
}

export class RouterHarness {
  readonly engines: FakeEngine[] = [];
  readonly requirements = new Map<string, RequirementsParams>();
  /** What each engine version registers with the editor when a document opens. */
  readonly registrationsOnOpen: Record<string, Array<{ id: string; method: string; registerOptions?: unknown }>> = {};
  /** Answers every engine gives to a request method. */
  readonly handlers: Record<string, (engine: FakeEngine, params: any) => unknown> = {};
  readonly capabilities: Record<string, ServerCapabilities>;
  readonly diagnostics = new Map<string, string[]>();
  readonly applied: unknown[] = [];
  readonly statuses: TeloStatus[] = [];
  readonly cache = new Map<string, CachedEngine>();
  /** Every write to the resolution store, in order. */
  readonly resolutionWrites: StoredResolutions[] = [];
  readonly logs: string[] = [];
  /** Every registration and withdrawal the editor received, in order. */
  readonly registrations: Array<{ register?: any[]; unregister?: any[] }> = [];
  /** The version every spawn named (`undefined` for the bundled engine). */
  readonly spawns: Array<string | undefined> = [];
  /** The code the host ships as its bundled engine, read at each load. */
  bundledCode: string;
  readonly router: LanguageRouter;
  readonly client: MessageConnection;
  private storedCatalog: StoredCatalog | undefined;

  constructor(options: HarnessOptions = {}) {
    this.storedCatalog = options.catalog;
    this.capabilities = options.capabilities ?? {};
    this.bundledCode = options.bundledCode ?? engineCode(BUNDLED);
    for (const [version, engine] of Object.entries(options.cached ?? {})) this.cache.set(version, engine);
    const transports = createInProcessTransports();
    const unserved = async (): Promise<never> => {
      throw new Error("not served in this test");
    };
    const files: HostFileSystem = { stat: unserved, readText: unserved, readDirectory: unserved };
    this.router = new LanguageRouter({
      client: transports.server,
      files,
      remote: options.remote ?? unserved,
      hub: new HubClient({ url: () => "https://hub.test", fetch: unserved }),
      resolutions: {
        read: async () => options.resolutions,
        write: async (resolutions) => void this.resolutionWrites.push(structuredClone(resolutions)),
      },
      spawner: {
        spawn: ({ version, bytes }) => {
          this.spawns.push(version);
          const code = readEngineCode(new TextDecoder().decode(bytes));
          if (!code) throw new Error(`spawned code that is not a fake engine`);
          if (version !== undefined && code.version !== version) {
            throw new Error(`spawned ${version} with the code of ${code.version}`);
          }
          const engine = new FakeEngine(code.version, code.behaviour, this);
          this.engines.push(engine);
          if (code.behaviour === "throws") engine.fail("SyntaxError: Unexpected token (engine module evaluation)");
          return {
            port: engine.port,
            onFailure: (listener) => engine.onFailure(listener),
            terminate: () => void (engine.terminated = true),
          };
        },
      },
      engineCache: {
        get: async (version) => this.cache.get(version),
        put: async (version, engine) => void this.cache.set(version, engine),
        has: async (version) => this.cache.has(version),
      },
      catalogCache: {
        read: async () => this.storedCatalog,
        write: async (catalog) => void (this.storedCatalog = catalog),
      },
      bundled: { load: async () => new TextEncoder().encode(this.bundledCode) },
      pin: options.pin,
      fetch:
        options.fetch ??
        (async () => {
          throw new TypeError("fetch failed: offline");
        }),
    });
    this.router.onStatus((status) => this.statuses.push(status));
    this.client = createMessageConnection(transports.client.reader, transports.client.writer);
    this.client.onNotification("textDocument/publishDiagnostics", (params: any) => {
      this.diagnostics.set(params.uri, params.diagnostics.map((d: { message: string }) => d.message));
    });
    this.client.onRequest("workspace/applyEdit", (params: unknown) => {
      this.applied.push(params);
      return { applied: true };
    });
    this.client.onNotification("window/logMessage", (params: { message: string }) => this.logs.push(params.message));
    this.client.onRequest("client/registerCapability", (params: any) => {
      this.registrations.push({ register: params.registrations });
      return null;
    });
    this.client.onRequest("client/unregisterCapability", (params: any) => {
      this.registrations.push({ unregister: params.unregisterations });
      return null;
    });
    this.client.listen();
  }

  async initialize(capabilities: ClientCapabilities = {}): Promise<any> {
    const result = await this.client.sendRequest("initialize", { processId: null, rootUri: null, capabilities });
    await this.client.sendNotification("initialized", {});
    return result;
  }

  open(uri: string): void {
    void this.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "telo", version: 1, text: "kind: Telo.Application\n" },
    });
  }

  close(uri: string): void {
    void this.client.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }

  engine(version: string): FakeEngine | undefined {
    return this.engines.filter((e) => e.version === version).at(-1);
  }

  /** The options the editor holds registered for a method, as the latest
   *  registration and withdrawal left them. */
  registered(method: string): any[] {
    const live = new Map<string, any>();
    for (const change of this.registrations) {
      for (const u of change.unregister ?? []) live.delete(u.id);
      for (const r of change.register ?? []) live.set(r.id, r);
    }
    return [...live.values()].filter((r) => r.method === method).map((r) => r.registerOptions);
  }

  /** Resolves once `predicate` holds. */
  async until(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** Requirements for an owner at `owner`, claiming `documents`. */
export function requirementsFor(
  owner: string,
  documents: string[],
  ranges: Array<{ module: string; text: string; min?: string; max?: string }>,
): RequirementsParams {
  return {
    owner,
    documents,
    ranges: ranges.map((r) => ({
      module: r.module,
      text: r.text,
      interval: {
        ...(r.min ? { min: { version: r.min, inclusive: true } } : {}),
        ...(r.max ? { max: { version: r.max, inclusive: false } } : {}),
      },
    })),
  };
}
