import type { ControllerContext, ResourceContext } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

import {
  asBundle,
  assertDistinct,
  type Bundle,
  type BundleLabel,
  type CapturedRef,
  captureHandler,
  type CatchEntry,
  type ResolvedHandler,
  resolveHandler,
} from "./entry-handler.js";

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

export interface ResolvedToolEntry extends ResolvedHandler {
  name: string;
  description?: string;
  argumentsSchema: Record<string, unknown>;
}

export async function register(_ctx: ControllerContext): Promise<void> {}

/** Passive bundle a transport reads at init, once injection has replaced each
 *  handler reference with its live instance. */
export class McpToolsBundle implements Bundle<ResolvedToolEntry> {
  private readonly label: BundleLabel;

  constructor(
    public readonly bundleName: string,
    private readonly raw: RawToolEntry[],
    private readonly captured: Map<RawToolEntry, CapturedRef>,
    private readonly ctx: ResourceContext,
  ) {
    this.label = { code: "TOOLS", bundle: `Mcp.Tools[${bundleName}]`, noun: "tool" };
  }

  get matchers(): string[] {
    return this.raw.map((entry) => this.nameOf(entry));
  }

  private nameOf(entry: RawToolEntry): string {
    if (!entry.name) {
      throw new RuntimeError(
        "ERR_MCP_TOOLS_INVALID",
        `${this.label.bundle}: entry declares no 'name', or an empty one`,
      );
    }
    return entry.name;
  }

  resolveEntries(): ResolvedToolEntry[] {
    return this.raw.map((raw) => {
      const name = this.nameOf(raw);
      const ref = this.captured.get(raw);
      if (!ref) {
        throw new RuntimeError(
          "ERR_MCP_TOOLS_NO_HANDLER",
          `${this.label.bundle}: tool '${name}' has no handler reference`,
        );
      }
      return {
        name,
        description: raw.description,
        argumentsSchema: raw.argumentsSchema ?? {},
        inputs: raw.inputs ?? {},
        result: raw.result ?? {},
        catches: raw.catches,
        handlerKind: ref.kind,
        handlerName: ref.name,
        handler: resolveHandler(raw.handler, ref, this.ctx, this.label, name),
      };
    });
  }
}

export function asToolsBundle(ref: unknown, label: string): McpToolsBundle {
  return asBundle<McpToolsBundle>(ref, label, "Mcp.Tools");
}

export async function create(
  resource: ToolsManifest,
  ctx: ResourceContext,
): Promise<McpToolsBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError("ERR_MCP_TOOLS_INVALID", "Mcp.Tools: metadata.name is required");
  }
  const entries = resource.entries ?? [];
  const label: BundleLabel = { code: "TOOLS", bundle: `Mcp.Tools[${bundleName}]`, noun: "tool" };

  const captured = new Map<RawToolEntry, CapturedRef>();
  for (const entry of entries) {
    captured.set(entry, captureHandler(entry.handler, ctx, label, entry.name ?? "<unnamed>"));
  }

  const bundle = new McpToolsBundle(bundleName, entries, captured, ctx);
  assertDistinct(bundle.matchers, label);
  return bundle;
}
