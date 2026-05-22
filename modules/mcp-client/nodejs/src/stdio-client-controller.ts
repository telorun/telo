import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  isInvokeError,
  type ControllerContext,
  type ResourceContext,
} from "@telorun/sdk";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  jsonRpcError,
  protocolError,
  transportError,
} from "./errors.js";

const DEFAULT_CLIENT_INFO = { name: "telo-mcp-client", version: "0.1.0" };
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

interface ClientInfo {
  name: string;
  version: string;
}

interface StdioClientManifest {
  metadata: { name: string };
  command: string;
  args?: string[];
  env?: Record<string, string>;
  clientInfo?: ClientInfo;
  shutdownGraceMs?: number;
}

interface InvokeInput {
  method: string;
  params?: Record<string, unknown>;
}

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpStdioClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly clientInfo: ClientInfo;

  constructor(
    private readonly manifest: StdioClientManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.clientInfo = manifest.clientInfo ?? DEFAULT_CLIENT_INFO;
  }

  async init(): Promise<void> {
    if (!this.manifest.command) {
      throw transportError("Mcp.StdioClient requires a `command` field");
    }
    // Build the child environment by merging process.env with the manifest's
    // extra env on top. Filter undefined entries from process.env to satisfy
    // the SDK's `Record<string, string>` typing.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(this.manifest.env ?? {})) {
      childEnv[k] = v;
    }

    // Resolve relative `./` / `../` entries in command + args against the
    // declaring manifest's directory rather than process.cwd(). Lets a test
    // manifest at modules/X/tests/foo.yaml reference a fixture at
    // ./__fixtures__/server.mjs without the test runner needing to chdir.
    const command = this.resolvePathArg(this.manifest.command);
    const args = (this.manifest.args ?? []).map((a) => this.resolvePathArg(a));

    const transport = new StdioClientTransport({
      command,
      args,
      env: childEnv,
      stderr: "pipe",
    });
    const client = new Client(this.clientInfo, { capabilities: {} });

    try {
      await client.connect(transport);
    } catch (err) {
      // Boot failure — surface as a transport error with whatever stderr the
      // child produced before exiting so the user can diagnose.
      throw transportError(
        `Mcp.StdioClient[${this.manifest.metadata.name}] failed to handshake on init: ${(err as Error).message}`,
        { command: this.manifest.command },
      );
    }

    // Forward child stderr to the kernel log per-line at debug level so a
    // chatty server doesn't grow the controller's memory footprint.
    const stderr = transport.stderr;
    if (stderr) {
      let leftover = "";
      stderr.on("data", (chunk: Buffer | string) => {
        const text = leftover + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        const lines = text.split(/\r?\n/);
        leftover = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          // emit non-awaited; stderr is non-critical observability
          this.ctx
            .emitEvent(`${this.manifest.metadata.name}.Stderr`, { line })
            .catch(() => {});
        }
      });
    }

    this.client = client;
    this.transport = transport;
  }

  async invoke(inputs: InvokeInput): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw transportError("Mcp.StdioClient.invoke called before init()");
    }
    if (!inputs || typeof inputs.method !== "string") {
      throw protocolError("Mcp.StdioClient.invoke requires inputs.method");
    }
    try {
      const { method, params } = inputs;
      if (method === "tools/call") {
        const callParams = (params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!callParams.name) {
          throw protocolError("tools/call requires params.name");
        }
        const res = await this.client.callTool({
          name: callParams.name,
          arguments: callParams.arguments ?? {},
        });
        return res as unknown as Record<string, unknown>;
      }
      if (method === "tools/list") {
        const res = await this.client.listTools((params ?? {}) as { cursor?: string });
        return res as unknown as Record<string, unknown>;
      }
      throw protocolError(
        `Mcp.StdioClient v1 does not implement method '${method}'`,
        { method },
      );
    } catch (err) {
      if (isInvokeError(err)) throw err;
      throw mapSdkError(err);
    }
  }

  private resolvePathArg(value: string): string {
    if (!value.startsWith("./") && !value.startsWith("../")) return value;
    if (isAbsolute(value)) return value;
    const source = this.ctx.moduleContext.source;
    if (!source.startsWith("file://")) return value;
    const baseDir = dirname(fileURLToPath(source));
    return resolve(baseDir, value);
  }

  snapshot(): Record<string, unknown> {
    return {
      command: this.manifest.command,
      argv: this.manifest.args ?? [],
      pid: this.transport?.pid ?? null,
    };
  }

  async teardown(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.transport = null;
    this.client = null;
    if (client) {
      const grace = this.manifest.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      // Capture the child pid before close() — the SDK clears its internal
      // process handle as part of close, so we can't read it back if the
      // close call hangs waiting for SIGTERM to take effect.
      const pid = transport?.pid ?? null;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // client.close() closes the transport, which sends SIGTERM to the
        // child. Wait up to `grace` ms for a clean exit; if grace expires
        // and the child is still alive, escalate to SIGKILL ourselves —
        // the SDK doesn't expose a kill-after-timeout option.
        const closed = client.close();
        const expired = new Promise<"timeout">((resolve) => {
          graceTimer = setTimeout(() => resolve("timeout"), grace);
        });
        const winner = await Promise.race([closed.then(() => "ok" as const), expired]);
        if (winner === "timeout" && pid !== null) {
          try {
            // Probe with signal 0 — throws if the process is gone, no-op
            // otherwise. Only escalate when the child is genuinely still up.
            process.kill(pid, 0);
            process.kill(pid, "SIGKILL");
            await this.ctx.emitEvent(`${this.manifest.metadata.name}.ChildForceKilled`, {
              pid,
              graceMs: grace,
            });
          } catch {
            // ESRCH or EPERM — child already exited or we can't signal it.
            // Either way, nothing left to do.
          }
        }
      } catch (err) {
        await this.ctx.emitEvent(`${this.manifest.metadata.name}.SdkCloseFailed`, {
          stage: "client",
          error: { message: (err as Error).message },
        });
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    } else if (transport) {
      try {
        await transport.close();
      } catch {
        // best effort
      }
    }
  }
}

function mapSdkError(err: unknown): Error {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && code < 0) {
    return jsonRpcError(code, (err as Error).message, (err as { data?: unknown }).data);
  }
  return transportError(
    `MCP stdio transport failed: ${(err as Error).message ?? String(err)}`,
  );
}

export async function create(
  resource: StdioClientManifest,
  ctx: ResourceContext,
): Promise<McpStdioClient> {
  return new McpStdioClient(resource, ctx);
}
