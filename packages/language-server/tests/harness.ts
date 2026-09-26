/**
 * An in-memory editor host for the engine: it drives `serve(port)` over a pair
 * of in-process message ports with plain JSON-RPC objects, serves every
 * `telo/*` request from the real fixture directories (and remote modules from
 * memory), and records everything the engine asks for and says.
 *
 * Every `telo/*` request and every `telo/requirements` notification is checked
 * against a closed projection of `editor-protocol-schema.json` (`closed-schema.ts`),
 * and every `file:` URI the engine sends against the canonical form, so a test
 * passing here also means the engine spoke the published contract and nothing
 * beyond it.
 */

import Ajv from "ajv";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inject } from "vitest";
import { closedProjection } from "./closed-schema.js";

const schema = closedProjection(
  JSON.parse(
    readFileSync(
      new URL("../node_modules/@telorun/editor-protocol/editor-protocol-schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema);
const methods = schema["x-telo-methods"] as Record<string, { params: string; result?: string }>;

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
export const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

export const uri = (path: string) => pathToFileURL(path).href;
export const pathOf = (u: string) => fileURLToPath(u);

/** `@telorun/editor-protocol` § URIs: no query or fragment; an empty authority
 *  for a local file, or a UNC share's lowercased host (never `localhost`); only
 *  unreserved characters, `/` and uppercase `%XX` escapes of anything else;
 *  a local Windows drive as `/<lowercase>%3A`. */
function isCanonicalFileUri(value: string): boolean {
  const match = /^file:\/\/((?:[a-z0-9\-._~]|%[0-9A-F]{2})*)(\/(?:[A-Za-z0-9\-._~/]|%[0-9A-F]{2})*)$/.exec(value);
  if (!match || match[1] === "localhost") return false;
  const escapesUnreserved = [...value.matchAll(/%([0-9A-F]{2})/g)].some((m) =>
    /[A-Za-z0-9\-._~/]/.test(String.fromCharCode(parseInt(m[1]!, 16))),
  );
  return !escapesUnreserved && !(match[1] === "" && /^\/[A-Z]%3A/.test(match[2]!));
}

function fileUris(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("file:")) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) fileUris(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      fileUris(key, found);
      fileUris(item, found);
    }
  }
  return found;
}

const entryKind = (entry: Dirent) =>
  entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};

export interface HostOptions {
  /** Modules at a non-file URI, served by `telo/read` as if a transport fetched them. */
  remote?: Record<string, string>;
  /** `telo/hub/listVersions` answers, by base ref. */
  versions?: Record<string, Array<{ version: string; integrity?: string }>>;
  capabilities?: Record<string, unknown>;
}

/** Every host a test started; `setup.ts` asserts none saw a contract violation. */
export const startedHosts: HarnessHost[] = [];

export class HarnessHost {
  /** Every request the engine sent, in order. */
  readonly requests: Array<{ method: string; params: any }> = [];
  /** Every notification the engine sent, in order. */
  readonly notifications: Array<{ method: string; params: any }> = [];
  /** `workspace/applyEdit` requests, answered as applied. */
  readonly appliedEdits: any[] = [];
  /** Protocol messages that did not validate against the closed schema, and
   *  `file:` URIs the engine sent in a non-canonical spelling. */
  readonly violations: string[] = [];

  private nextId = 1;
  private readonly pending = new Map<number | string, (m: Message) => void>();
  private readonly waiters: Array<() => void> = [];
  private readonly toEngine: Array<(event: { data: unknown }) => void> = [];
  private versions = new Map<string, number>();

  constructor(private readonly options: HostOptions = {}) {
    startedHosts.push(this);
  }

  async start(): Promise<any> {
    const { serve } = await import(inject("engineBundle"));
    serve({
      postMessage: (message: unknown) => {
        const copy = structuredClone(message) as Message;
        setTimeout(() => void this.receive(copy), 0);
      },
      addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
        this.toEngine.push(listener);
      },
    });
    const result = await this.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: this.options.capabilities ?? {},
    });
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolvePromise(m.result)));
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  open(path: string, text = readFileSync(path, "utf8")): void {
    this.versions.set(path, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri: uri(path), languageId: "telo", version: 1, text },
    });
  }

  change(path: string, text: string): void {
    const version = (this.versions.get(path) ?? 1) + 1;
    this.versions.set(path, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri: uri(path), version },
      contentChanges: [{ text }],
    });
  }

  /** The latest diagnostics published per file path. */
  diagnostics(): Map<string, any[]> {
    const latest = new Map<string, any[]>();
    for (const n of this.notifications) {
      if (n.method === "textDocument/publishDiagnostics") latest.set(pathOf(n.params.uri), n.params.diagnostics);
    }
    return latest;
  }

  /** Resolves once `predicate` holds over what the engine has sent. */
  async until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  /** Resolves once diagnostics for `path` have been published `count` times. */
  published(path: string, count = 1): Promise<void> {
    return this.until(
      () =>
        this.notifications.filter(
          (n) => n.method === "textDocument/publishDiagnostics" && pathOf(n.params.uri) === path,
        ).length >= count,
      `diagnostics for ${path}`,
    );
  }

  private send(message: Message): void {
    const copy = structuredClone(message);
    setTimeout(() => {
      for (const listener of this.toEngine) listener({ data: copy });
    }, 0);
  }

  private async receive(message: Message): Promise<void> {
    for (const found of fileUris([message.params, message.result])) {
      if (!isCanonicalFileUri(found)) this.violations.push(`${message.method ?? "a response"} carries a non-canonical URI: ${found}`);
    }
    if (message.id !== undefined && message.method === undefined) {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    } else if (message.id !== undefined && message.method !== undefined) {
      this.requests.push({ method: message.method, params: message.params });
      this.check(message.method, "params", message.params);
      try {
        const result = await this.serveRequest(message.method, message.params);
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    } else if (message.method !== undefined) {
      this.notifications.push({ method: message.method, params: message.params });
      this.check(message.method, "params", message.params);
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  private check(method: string, part: "params" | "result", value: unknown): void {
    const ref = methods[method]?.[part];
    if (!ref) return;
    const validate = ajv.getSchema(`${schema.$id}${ref}`)!;
    if (!validate(value)) {
      this.violations.push(`${method} ${part}: ${ajv.errorsText(validate.errors)}`);
    }
  }

  private async serveRequest(method: string, params: any): Promise<unknown> {
    const result = await this.answer(method, params);
    this.check(method, "result", result);
    return result;
  }

  private async answer(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "telo/read": {
        const remote = this.options.remote?.[params.uri];
        if (remote !== undefined) return { uri: params.uri, text: remote };
        if (!params.uri.startsWith("file:")) {
          throw new Error(`this host has no transport for ${params.uri}`);
        }
        let path = pathOf(params.uri);
        if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "telo.yaml");
        if (!existsSync(path)) return null;
        return { uri: uri(path), text: readFileSync(path, "utf8") };
      }
      case "telo/exists":
        return existsSync(resolve(dirname(pathOf(params.base)), params.relative));
      case "telo/listDirectory": {
        const path = pathOf(params.uri);
        if (!existsSync(path) || !statSync(path).isDirectory()) return null;
        return readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, kind: entryKind(e) }));
      }
      case "telo/hub/searchRefs":
        return [];
      case "telo/hub/listVersions":
        return this.options.versions?.[params.ref] ?? [];
      case "workspace/applyEdit":
        this.appliedEdits.push(params);
        return { applied: true };
      default:
        return null;
    }
  }
}
