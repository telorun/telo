import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isInvokeError, type ResourceContext, RuntimeError } from "@telorun/sdk";

import { matchCatch, type ModuleLikeContext, type ResolvedToolEntry } from "./outcome.js";
import type { McpToolsBundle } from "./tools-controller.js";

export interface ServerInfo {
  name: string;
  version: string;
}

export interface BuildOptions {
  serverInfo: ServerInfo;
  /** Optional primer carried as the SDK Server's `instructions` option;
   *  surfaced to clients on `initialize`. */
  instructions?: string;
  toolsBundles: McpToolsBundle[];
  /** Per-session metadata exposed to CEL inputs as `request.session`. */
  sessionResolver: () => SessionContext;
  ctx: ResourceContext;
  moduleContext: ModuleLikeContext;
}

export interface SessionContext {
  id: string;
  clientInfo: { name?: string; version?: string } | Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

/** Merge entries from every bundle, throwing if two bundles register the same
 *  tool name. The plan calls for the analyzer to also catch this at compile
 *  time (§5.1 item 2) — this runtime guard backstops it until that lands. */
function mergeToolEntries(bundles: McpToolsBundle[]): Map<string, ResolvedToolEntry> {
  const byName = new Map<string, ResolvedToolEntry>();
  const owners = new Map<string, string>();
  for (const bundle of bundles) {
    for (const entry of bundle.resolveEntries()) {
      const priorOwner = owners.get(entry.name);
      if (priorOwner) {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_DUPLICATE",
          `Mcp: duplicate tool name '${entry.name}' across bundles '${priorOwner}' and '${bundle.bundleName}'`,
        );
      }
      owners.set(entry.name, bundle.bundleName);
      byName.set(entry.name, entry);
    }
  }
  return byName;
}

/** Build a fully-wired SDK Server. For stdio the caller connects this once;
 *  for streamable HTTP a fresh Server is built per session, so this is called
 *  every time a new Mcp-Session-Id is minted. */
export function buildServer(opts: BuildOptions): Server {
  const tools = mergeToolEntries(opts.toolsBundles);

  const server = new Server(
    { name: opts.serverInfo.name, version: opts.serverInfo.version },
    {
      capabilities: { tools: {} },
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    },
  );

  const advertised = Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.argumentsSchema as Record<string, unknown>,
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: advertised }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new RuntimeError(
        "ERR_MCP_UNKNOWN_TOOL",
        `Mcp: unknown tool '${request.params.name}'`,
      );
    }

    const session = opts.sessionResolver();
    const requestCtx: Record<string, unknown> = {
      request: {
        name: tool.name,
        arguments: request.params.arguments ?? {},
        meta: (request.params as { _meta?: unknown })._meta ?? {},
        session: {
          id: session.id,
          clientInfo: session.clientInfo,
          capabilities: session.capabilities,
        },
      },
    };

    const inputs = opts.moduleContext.expandWith(tool.inputs, requestCtx) as Record<
      string,
      unknown
    >;

    let handlerResult: unknown;
    try {
      handlerResult = await opts.ctx.invokeResolved(
        tool.handlerKind,
        tool.handlerName,
        tool.handler,
        { ...inputs, inputs },
      );
    } catch (err) {
      if (!isInvokeError(err)) throw err;
      const errPayload = { code: err.code, message: err.message, data: err.data };
      const celCtx = { error: errPayload, request: requestCtx.request };
      const matched = matchCatch(tool.catches, errPayload, celCtx, opts.moduleContext);
      if (!matched) {
        throw err;
      }
      const expanded = opts.moduleContext.expandWith(matched.error, celCtx) as {
        code: number;
        message: string;
        data?: unknown;
      };
      const ipcError: Error & { code?: number; data?: unknown } = new Error(expanded.message);
      ipcError.code = expanded.code;
      ipcError.data = expanded.data;
      throw ipcError;
    }

    const resultCtx = { result: handlerResult, request: requestCtx.request };
    const rendered = opts.moduleContext.expandWith(tool.result, resultCtx) as Record<
      string,
      unknown
    >;

    // Schema requires `content` to be present, but the value comes from CEL
    // expansion at runtime so its type can't be enforced statically. Verify
    // the expanded shape here.
    if (!Array.isArray((rendered as { content?: unknown }).content)) {
      throw new RuntimeError(
        "ERR_MCP_RESULT_INVALID",
        `Mcp: tool '${tool.name}' result.content is not an array of content blocks`,
      );
    }
    return rendered as { content: unknown[] };
  });

  return server;
}
