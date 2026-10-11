import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type InvokeContext,
  isInvokeError,
  type ResourceContext,
  RuntimeError,
  toPlainJson,
} from "@telorun/sdk";

import { assertDistinctAcross, type ResolvedHandler } from "./entry-handler.js";
import { matchCatch, type ModuleLikeContext } from "./outcome.js";
import { asPromptsBundle, type McpPromptsBundle } from "./prompts-controller.js";
import {
  asResourcesBundle,
  type McpResourcesBundle,
  type ResolvedResourceEntry,
} from "./resources-controller.js";
import { asToolsBundle, type McpToolsBundle } from "./tools-controller.js";

export interface ServerInfo {
  name: string;
  version: string;
}

export interface Bundles {
  tools: McpToolsBundle[];
  resources: McpResourcesBundle[];
  prompts: McpPromptsBundle[];
}

export interface BuildOptions {
  serverInfo: ServerInfo;
  /** Optional primer carried as the SDK Server's `instructions` option;
   *  surfaced to clients on `initialize`. */
  instructions?: string;
  bundles: Bundles;
  /** Per-session metadata exposed to CEL inputs as `request.session`. */
  sessionResolver: () => SessionContext;
  /** The context a call dispatches on, by its JSON-RPC request id: the
   *  context of the transport request that carried it. */
  dispatchContext: (requestId: RequestId) => InvokeContext;
  ctx: ResourceContext;
  moduleContext: ModuleLikeContext;
}

export interface SessionContext {
  id: string;
  clientInfo: { name?: string; version?: string } | Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;

/** A transport's three bundle slots as live bundles. Called from init(), so a
 *  matcher two bundles of one surface both declare stops the boot rather than
 *  the first request. */
export function resolveBundles(
  slots: { tools?: unknown[]; resources?: unknown[]; prompts?: unknown[] },
  label: string,
): Bundles {
  const bundles: Bundles = {
    tools: (slots.tools ?? []).map((ref) => asToolsBundle(ref, label)),
    resources: (slots.resources ?? []).map((ref) => asResourcesBundle(ref, label)),
    prompts: (slots.prompts ?? []).map((ref) => asPromptsBundle(ref, label)),
  };
  assertDistinctAcross(bundles.tools, "TOOLS", "tool name");
  assertDistinctAcross(bundles.resources, "RESOURCES", "resource URI");
  assertDistinctAcross(bundles.prompts, "PROMPTS", "prompt name");
  return bundles;
}

function jsonRpcError(code: number, message: string, data?: unknown): Error {
  const error: Error & { code?: number; data?: unknown } = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

/** `inputs:` → handler → `result:`, with a thrown InvokeError mapped through
 *  the entry's `catches:` to a JSON-RPC error. */
async function dispatch(
  opts: BuildOptions,
  entry: ResolvedHandler,
  request: Record<string, unknown>,
  requestId: RequestId,
): Promise<Record<string, unknown>> {
  const inputs = opts.moduleContext.expandWith(entry.inputs, { request }) as Record<
    string,
    unknown
  >;

  let handlerResult: unknown;
  try {
    handlerResult = await opts.ctx.invokeResolved(
      entry.handlerKind,
      entry.handlerName,
      entry.handler,
      { ...inputs, inputs },
      opts.dispatchContext(requestId),
    );
  } catch (err) {
    if (!isInvokeError(err)) throw err;
    const errPayload = { code: err.code, message: err.message, data: err.data };
    const celCtx = { error: errPayload, request };
    const matched = matchCatch(entry.catches, errPayload, celCtx, opts.moduleContext);
    if (!matched) throw err;
    const expanded = opts.moduleContext.expandWith(matched.error, celCtx) as {
      code: number;
      message: string;
      data?: unknown;
    };
    throw jsonRpcError(expanded.code, expanded.message, toPlainJson(expanded.data));
  }

  return opts.moduleContext.expandWith(entry.result, { result: handlerResult, request }) as Record<
    string,
    unknown
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP carries binary as standard base64, which is not the plain encoding of
 *  bytes: resource contents (`blob`), an image or audio block (`data`), and the
 *  resource a block embeds. */
function standardBase64(block: Record<string, unknown>): Record<string, unknown> {
  const out = { ...block };
  for (const field of ["blob", "data"]) {
    const value = out[field];
    if (value instanceof Uint8Array) out[field] = Buffer.from(value).toString("base64");
  }
  if (isRecord(out.resource)) out.resource = standardBase64(out.resource);
  return out;
}

function sessionOf(opts: BuildOptions) {
  const session = opts.sessionResolver();
  return { id: session.id, clientInfo: session.clientInfo, capabilities: session.capabilities };
}

function metaOf(params: unknown): unknown {
  return (params as { _meta?: unknown })._meta ?? {};
}

function registerTools(server: Server, opts: BuildOptions): void {
  const tools = new Map(
    opts.bundles.tools.flatMap((b) => b.resolveEntries()).map((t) => [t.name, t] as const),
  );

  const advertised = Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.argumentsSchema,
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: advertised }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new RuntimeError("ERR_MCP_UNKNOWN_TOOL", `Mcp: unknown tool '${request.params.name}'`);
    }

    const rendered = await dispatch(
      opts,
      tool,
      {
        name: tool.name,
        arguments: request.params.arguments ?? {},
        meta: metaOf(request.params),
        session: sessionOf(opts),
      },
      extra.requestId,
    );

    // `content` comes from CEL, so its shape is only known once rendered.
    if (!Array.isArray(rendered.content)) {
      throw new RuntimeError(
        "ERR_MCP_RESULT_INVALID",
        `Mcp: tool '${tool.name}' result.content is not an array of content blocks`,
      );
    }
    // The MCP client is not Telo, so a CEL value in the result (a timestamp in
    // `structuredContent`) is written in its plain encoding, never type-tagged.
    return toPlainJson(rendered) as { content: unknown[] };
  });
}

function registerResources(server: Server, opts: BuildOptions): void {
  const entries = opts.bundles.resources.flatMap((b) => b.resolveEntries());
  const fixed = new Map<string, ResolvedResourceEntry>();
  const templated: ResolvedResourceEntry[] = [];
  for (const entry of entries) {
    if (entry.uri !== undefined) fixed.set(entry.uri, entry);
    else templated.push(entry);
  }

  const describe = (e: ResolvedResourceEntry) => ({
    name: e.name,
    description: e.description,
    mimeType: e.mimeType,
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: Array.from(fixed.values()).map((e) => ({ uri: e.uri!, ...describe(e) })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: templated.map((entry) => ({
      uriTemplate: entry.uriTemplate!,
      ...describe(entry),
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = request.params.uri;
    let entry = fixed.get(uri);
    let params: Record<string, unknown> = {};
    if (!entry) {
      for (const candidate of templated) {
        const variables = candidate.template!.match(uri);
        if (variables) {
          entry = candidate;
          params = variables;
          break;
        }
      }
    }
    if (!entry) {
      throw jsonRpcError(RESOURCE_NOT_FOUND, `Mcp: resource '${uri}' not found`, { uri });
    }

    const rendered = await dispatch(
      opts,
      entry,
      { uri, params, meta: metaOf(request.params), session: sessionOf(opts) },
      extra.requestId,
    );

    const contents = rendered.contents;
    if (
      !Array.isArray(contents) ||
      !contents.every((item) => isRecord(item) && typeof item.uri === "string")
    ) {
      throw new RuntimeError(
        "ERR_MCP_RESULT_INVALID",
        `Mcp: resource '${uri}' result.contents is not an array of resource contents, each an object with a 'uri'`,
      );
    }
    return toPlainJson({ ...rendered, contents: contents.map(standardBase64) }) as {
      contents: never[];
    };
  });
}

function registerPrompts(server: Server, opts: BuildOptions): void {
  const prompts = new Map(
    opts.bundles.prompts.flatMap((b) => b.resolveEntries()).map((p) => [p.name, p] as const),
  );

  const advertised = Array.from(prompts.values()).map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: advertised }));

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const prompt = prompts.get(request.params.name);
    if (!prompt) {
      throw jsonRpcError(INVALID_PARAMS, `Mcp: unknown prompt '${request.params.name}'`);
    }
    const args = request.params.arguments ?? {};
    const missing = prompt.arguments.filter((a) => a.required && !Object.hasOwn(args, a.name));
    if (missing.length > 0) {
      throw jsonRpcError(
        INVALID_PARAMS,
        `Mcp: prompt '${prompt.name}' is missing required argument${missing.length > 1 ? "s" : ""} ${missing.map((a) => `'${a.name}'`).join(", ")}`,
      );
    }

    const rendered = await dispatch(
      opts,
      prompt,
      {
        name: prompt.name,
        arguments: args,
        meta: metaOf(request.params),
        session: sessionOf(opts),
      },
      extra.requestId,
    );

    const messages = rendered.messages;
    if (
      !Array.isArray(messages) ||
      !messages.every((m) => isRecord(m) && typeof m.role === "string" && isRecord(m.content))
    ) {
      throw new RuntimeError(
        "ERR_MCP_RESULT_INVALID",
        `Mcp: prompt '${prompt.name}' result.messages is not an array of prompt messages, each an object with a 'role' and a 'content' block`,
      );
    }
    return toPlainJson({
      ...rendered,
      messages: messages.map((m) => ({ ...m, content: standardBase64(m.content) })),
    }) as { messages: never[] };
  });
}

/** Build a fully-wired SDK Server. For stdio the caller connects this once;
 *  for streamable HTTP a fresh Server is built per session, so this is called
 *  every time a new Mcp-Session-Id is minted. */
export function buildServer(opts: BuildOptions): Server {
  const { resources, prompts } = opts.bundles;

  const server = new Server(
    { name: opts.serverInfo.name, version: opts.serverInfo.version },
    {
      capabilities: {
        tools: {},
        ...(resources.length > 0 ? { resources: {} } : {}),
        ...(prompts.length > 0 ? { prompts: {} } : {}),
      },
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    },
  );

  registerTools(server, opts);
  if (resources.length > 0) registerResources(server, opts);
  if (prompts.length > 0) registerPrompts(server, opts);

  return server;
}
