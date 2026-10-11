import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
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

interface RawResourceEntry {
  uri?: string;
  uriTemplate?: string;
  name?: string;
  description?: string;
  mimeType?: string;
  handler?: unknown;
  inputs?: Record<string, unknown>;
  result?: Record<string, unknown>;
  catches?: CatchEntry[];
}

interface ResourcesManifest {
  metadata?: { name?: string };
  entries?: RawResourceEntry[];
}

/** Exactly one of `uri` / `uriTemplate` is set; `template` is the parsed `uriTemplate`. */
export interface ResolvedResourceEntry extends ResolvedHandler {
  uri?: string;
  uriTemplate?: string;
  template?: UriTemplate;
  name: string;
  description?: string;
  mimeType?: string;
}

// The twin of the `pattern` on `uriTemplate` in telo.yaml.
const WELL_FORMED_TEMPLATE = /^([^{}]|\{[^{}]+\})+$/;

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpResourcesBundle implements Bundle<ResolvedResourceEntry> {
  private readonly label: BundleLabel;
  private readonly templates = new Map<RawResourceEntry, UriTemplate>();

  constructor(
    public readonly bundleName: string,
    private readonly raw: RawResourceEntry[],
    private readonly captured: Map<RawResourceEntry, CapturedRef>,
    private readonly ctx: ResourceContext,
  ) {
    this.label = {
      code: "RESOURCES",
      bundle: `Mcp.Resources[${bundleName}]`,
      noun: "resource",
    };
    for (const entry of raw) {
      this.matcherOf(entry);
      if (entry.uriTemplate !== undefined) {
        this.templates.set(entry, this.parseTemplate(entry.uriTemplate));
      }
    }
  }

  private parseTemplate(source: string): UriTemplate {
    const invalid = (reason: string) =>
      new RuntimeError(
        "ERR_MCP_RESOURCES_INVALID",
        `${this.label.bundle}: uriTemplate '${source}' is not a URI template: ${reason}`,
      );
    if (!WELL_FORMED_TEMPLATE.test(source)) {
      throw invalid("every '{' must close and name a variable");
    }
    try {
      return new UriTemplate(source);
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : String(err));
    }
  }

  get matchers(): string[] {
    return this.raw.map((entry) => this.matcherOf(entry));
  }

  private matcherOf(entry: RawResourceEntry): string {
    const matcher = entry.uri ?? entry.uriTemplate;
    if (matcher === undefined || (entry.uri !== undefined && entry.uriTemplate !== undefined)) {
      throw new RuntimeError(
        "ERR_MCP_RESOURCES_INVALID",
        `${this.label.bundle}: resource '${entry.name ?? "<unnamed>"}' must declare exactly one of 'uri' and 'uriTemplate'`,
      );
    }
    if (matcher === "") {
      throw new RuntimeError(
        "ERR_MCP_RESOURCES_INVALID",
        `${this.label.bundle}: resource '${entry.name ?? "<unnamed>"}' declares an empty URI`,
      );
    }
    return matcher;
  }

  resolveEntries(): ResolvedResourceEntry[] {
    return this.raw.map((raw) => {
      const matcher = this.matcherOf(raw);
      const ref = this.captured.get(raw);
      if (!ref) {
        throw new RuntimeError(
          "ERR_MCP_RESOURCES_NO_HANDLER",
          `${this.label.bundle}: resource '${matcher}' has no handler reference`,
        );
      }
      return {
        uri: raw.uri,
        uriTemplate: raw.uriTemplate,
        template: this.templates.get(raw),
        name: raw.name ?? matcher,
        description: raw.description,
        mimeType: raw.mimeType,
        inputs: raw.inputs ?? {},
        result: raw.result ?? {},
        catches: raw.catches,
        handlerKind: ref.kind,
        handlerName: ref.name,
        handler: resolveHandler(raw.handler, ref, this.ctx, this.label, matcher),
      };
    });
  }
}

export function asResourcesBundle(ref: unknown, label: string): McpResourcesBundle {
  return asBundle<McpResourcesBundle>(ref, label, "Mcp.Resources");
}

export async function create(
  resource: ResourcesManifest,
  ctx: ResourceContext,
): Promise<McpResourcesBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError(
      "ERR_MCP_RESOURCES_INVALID",
      "Mcp.Resources: metadata.name is required",
    );
  }
  const entries = resource.entries ?? [];
  const label: BundleLabel = {
    code: "RESOURCES",
    bundle: `Mcp.Resources[${bundleName}]`,
    noun: "resource",
  };

  const captured = new Map<RawResourceEntry, CapturedRef>();
  for (const entry of entries) {
    captured.set(
      entry,
      captureHandler(entry.handler, ctx, label, entry.uri ?? entry.uriTemplate ?? "<unnamed>"),
    );
  }

  const bundle = new McpResourcesBundle(bundleName, entries, captured, ctx);
  assertDistinct(bundle.matchers, label);
  return bundle;
}
