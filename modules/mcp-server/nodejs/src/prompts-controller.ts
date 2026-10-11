import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";

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

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

interface RawPromptEntry {
  name?: string;
  description?: string;
  arguments?: PromptArgument[];
  handler?: unknown;
  inputs?: Record<string, unknown>;
  result?: Record<string, unknown>;
  catches?: CatchEntry[];
}

interface PromptsManifest {
  metadata?: { name?: string };
  entries?: RawPromptEntry[];
}

export interface ResolvedPromptEntry extends ResolvedHandler {
  name: string;
  description?: string;
  arguments: PromptArgument[];
}

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpPromptsBundle implements Bundle<ResolvedPromptEntry> {
  private readonly label: BundleLabel;

  constructor(
    public readonly bundleName: string,
    private readonly raw: RawPromptEntry[],
    private readonly captured: Map<RawPromptEntry, CapturedRef>,
    private readonly ctx: ResourceContext,
  ) {
    this.label = { code: "PROMPTS", bundle: `Mcp.Prompts[${bundleName}]`, noun: "prompt" };
  }

  get matchers(): string[] {
    return this.raw.map((entry) => this.nameOf(entry));
  }

  private nameOf(entry: RawPromptEntry): string {
    if (!entry.name) {
      throw new RuntimeError(
        "ERR_MCP_PROMPTS_INVALID",
        `${this.label.bundle}: entry declares no 'name', or an empty one`,
      );
    }
    return entry.name;
  }

  resolveEntries(): ResolvedPromptEntry[] {
    return this.raw.map((raw) => {
      const name = this.nameOf(raw);
      const ref = this.captured.get(raw);
      if (!ref) {
        throw new RuntimeError(
          "ERR_MCP_PROMPTS_NO_HANDLER",
          `${this.label.bundle}: prompt '${name}' has no handler reference`,
        );
      }
      return {
        name,
        description: raw.description,
        arguments: raw.arguments ?? [],
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

export function asPromptsBundle(ref: unknown, label: string): McpPromptsBundle {
  return asBundle<McpPromptsBundle>(ref, label, "Mcp.Prompts");
}

export async function create(
  resource: PromptsManifest,
  ctx: ResourceContext,
): Promise<McpPromptsBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError("ERR_MCP_PROMPTS_INVALID", "Mcp.Prompts: metadata.name is required");
  }
  const entries = resource.entries ?? [];
  const label: BundleLabel = {
    code: "PROMPTS",
    bundle: `Mcp.Prompts[${bundleName}]`,
    noun: "prompt",
  };

  const captured = new Map<RawPromptEntry, CapturedRef>();
  for (const entry of entries) {
    captured.set(entry, captureHandler(entry.handler, ctx, label, entry.name ?? "<unnamed>"));
  }

  const bundle = new McpPromptsBundle(bundleName, entries, captured, ctx);
  assertDistinct(bundle.matchers, label);
  return bundle;
}
