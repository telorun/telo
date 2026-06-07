import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

import type { CatchEntry, ResolvedToolEntry } from "./outcome.js";

/** Manifest shape pre-Phase-5. The handler field is still {kind, name} (or a
 *  bare name string) at create() time; Phase 5 swaps it for a live
 *  ResourceInstance before consumers (transports) read .entries. */
interface RawToolEntry {
  name?: string;
  description?: string;
  argumentsSchema?: Record<string, unknown>;
  handler?: unknown;
  inputs?: Record<string, unknown>;
  result?: Record<string, unknown>;
  catches?: CatchEntry[];
}

interface ToolsManifest {
  metadata?: { name?: string; module?: string };
  entries?: RawToolEntry[];
}

interface CapturedRef {
  kind: string;
  name: string;
}

export async function register(_ctx: ControllerContext): Promise<void> {}

/** Passive bundle exposed via ctx.moduleContext.getInstance(name). The
 *  transport (StdioServer / HttpEndpoint) reads `.entries` after Phase 5
 *  injection — handler refs in each entry are then live ResourceInstances. */
export class McpToolsBundle {
  constructor(
    public readonly bundleName: string,
    private readonly raw: RawToolEntry[],
    private readonly captured: Map<RawToolEntry, CapturedRef>,
    private readonly ctx: ResourceContext,
  ) {}

  /** Resolve the raw entries into ResolvedToolEntry records suitable for
   *  registry consumption. Called from a transport's init() — at that point
   *  Phase 5 has injected live handler instances over the captured object refs.
   *  String-form refs are resolved here via moduleContext.getInstance(). */
  resolveEntries(): ResolvedToolEntry[] {
    const seen = new Set<string>();
    const resolved: ResolvedToolEntry[] = [];
    for (const raw of this.raw) {
      const name = raw.name;
      if (!name) {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_INVALID",
          `Mcp.Tools[${this.bundleName}]: entry is missing 'name'`,
        );
      }
      if (seen.has(name)) {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_DUPLICATE",
          `Mcp.Tools[${this.bundleName}]: duplicate tool name '${name}' within the same bundle`,
        );
      }
      seen.add(name);

      const ref = this.captured.get(raw);
      if (!ref) {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_NO_HANDLER",
          `Mcp.Tools[${this.bundleName}]: tool '${name}' has no handler reference`,
        );
      }

      let handlerInstance: ResourceInstance | undefined;
      if (typeof raw.handler === "string") {
        // moduleContext.getInstance(name) throws a plain Error when the
        // resource is missing. Wrap it so misconfigured string refs surface
        // as the MCP-specific ERR_MCP_TOOLS_HANDLER_UNRESOLVED with the
        // bundle/tool location included.
        try {
          handlerInstance = this.ctx.moduleContext.getInstance(ref.name) as ResourceInstance;
        } catch (err) {
          throw new RuntimeError(
            "ERR_MCP_TOOLS_HANDLER_UNRESOLVED",
            `Mcp.Tools[${this.bundleName}]: tool '${name}' handler '${ref.name}' not found: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (raw.handler && typeof raw.handler === "object") {
        // Phase 5 injection has replaced the {kind, name} ref with the live
        // ResourceInstance — unless the referenced resource was missing, in
        // which case Phase 5 leaves the {kind, name} object in place. Detect
        // that case via the absence of `invoke` below.
        handlerInstance = raw.handler as ResourceInstance;
      }
      if (!handlerInstance || typeof (handlerInstance as { invoke?: unknown }).invoke !== "function") {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_HANDLER_UNRESOLVED",
          `Mcp.Tools[${this.bundleName}]: tool '${name}' handler '${ref.kind || "?"}.${ref.name}' did not resolve to a live Invocable — Phase 5 injection may have failed`,
        );
      }

      resolved.push({
        name,
        description: raw.description,
        argumentsSchema: (raw.argumentsSchema ?? {}) as Record<string, unknown>,
        inputs: (raw.inputs ?? {}) as Record<string, unknown>,
        result: (raw.result ?? {}) as Record<string, unknown>,
        catches: raw.catches,
        handlerKind: ref.kind,
        handlerName: ref.name,
        handler: handlerInstance,
      });
    }
    return resolved;
  }
}

/** Narrow a transport's `tools` bundle slot to its live `McpToolsBundle`. The
 *  `!ref` at the slot is replaced with the live instance by the kernel's Phase-5
 *  injection before the transport's init() runs, so the value is used directly. */
export function asToolsBundle(ref: unknown, label: string): McpToolsBundle {
  if (ref && typeof (ref as McpToolsBundle).resolveEntries === "function") {
    return ref as McpToolsBundle;
  }
  throw new RuntimeError(
    "ERR_MCP_BUNDLE_NOT_FOUND",
    `${label}: a tools bundle did not resolve to a live Mcp.Tools instance`,
  );
}

export async function create(
  resource: ToolsManifest,
  ctx: ResourceContext,
): Promise<McpToolsBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError(
      "ERR_MCP_TOOLS_INVALID",
      "Mcp.Tools: metadata.name is required",
    );
  }
  const entries = resource.entries ?? [];

  const captured = new Map<RawToolEntry, CapturedRef>();
  for (const entry of entries) {
    const handler = entry.handler;
    if (!handler) {
      throw new RuntimeError(
        "ERR_MCP_TOOLS_INVALID",
        `Mcp.Tools[${bundleName}]: tool '${entry.name ?? "<unnamed>"}' missing handler`,
      );
    }
    if (typeof handler === "object") {
      captured.set(entry, ctx.resolveChildren(handler));
    } else if (typeof handler === "string") {
      // Bare name reference (oneOf: string). Phase 5 injection only replaces
      // {kind, name} object refs — string refs survive as the resource name.
      // We capture the name here so the dispatcher can still look up the
      // instance via moduleContext.getInstance() at invoke time.
      captured.set(entry, { kind: "", name: handler });
    }
  }

  return new McpToolsBundle(bundleName, entries, captured, ctx);
}
