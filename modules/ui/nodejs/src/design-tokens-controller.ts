import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";

/**
 * The closed set of design token names, spelled as a token set writes them —
 * the properties `Ui.DesignTokens` declares, which a test holds equal.
 */
export const DESIGN_TOKENS = [
  "color.background",
  "color.surface",
  "color.text",
  "color.muted",
  "color.border",
  "color.accent",
  "color.accent-text",
  "color.danger",
  "color.warning",
  "color.success",
  "radius.sm",
  "radius.md",
  "radius.lg",
  "space.xs",
  "space.sm",
  "space.md",
  "space.lg",
  "space.xl",
  "space.page",
  "shadow.sm",
  "shadow.md",
  "font.body",
  "font.heading",
  "font.mono",
  "font-size.sm",
  "font-size.md",
  "font-size.lg",
  "font-size.xl",
  "line-height.body",
  "line-height.heading",
  "width.page",
] as const;

export type DesignTokenName = (typeof DESIGN_TOKENS)[number];

/** A token set as written: each token at the resource's top level, beside `kind` and `metadata`. */
type DesignTokensResource = RuntimeResource & Record<string, unknown>;

/** A typeface as a token set hands it on: the name, and whatever face bytes it declares. */
export interface TokenFont {
  family: string;
  faces: Record<string, Uint8Array | undefined>;
}

/** What a token set provides: its CSS-valued tokens, and its typefaces, by token name. */
export interface DesignTokenValues {
  tokens: Record<string, string>;
  fonts: Record<string, TokenFont>;
}

function isFont(candidate: unknown): candidate is TokenFont {
  const font = candidate as TokenFont | null;
  return typeof font?.family === "string" && typeof font.faces === "object";
}

class DesignTokens implements ResourceInstance {
  constructor(
    private readonly resource: DesignTokensResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<DesignTokenValues> {
    const name = this.resource.metadata.name;
    const provided: DesignTokenValues = { tokens: {}, fonts: {} };
    for (const [token, value] of Object.entries(this.resource)) {
      if (token === "kind" || token === "metadata") continue;
      if (token.startsWith("font.")) {
        const font = this.ctx.resolveRef(value, isFont, () => `'${token}' of Ui.DesignTokens '${name}'`, "Font.Family");
        provided.fonts[token] = { family: font.family, faces: font.faces };
      } else {
        provided.tokens[token] = String(value);
      }
    }
    return provided;
  }
}

export async function create(resource: DesignTokensResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new DesignTokens(resource, ctx);
}
