import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";

type ThemeResource = RuntimeResource & { tokens: Record<string, unknown> };

/** A typeface as a theme hands it on: the name, and whatever face bytes it declares. */
export interface ThemeFont {
  family: string;
  faces: Record<string, Uint8Array | undefined>;
}

/** What a theme provides: its CSS-valued tokens, and its typefaces, by token name. */
export interface ThemeTokens {
  tokens: Record<string, string>;
  fonts: Record<string, ThemeFont>;
}

function isFont(candidate: unknown): candidate is ThemeFont {
  const font = candidate as ThemeFont | null;
  return typeof font?.family === "string" && typeof font.faces === "object";
}

class Theme implements ResourceInstance {
  constructor(
    private readonly resource: ThemeResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<ThemeTokens> {
    const name = this.resource.metadata.name;
    const provided: ThemeTokens = { tokens: {}, fonts: {} };
    for (const [token, value] of Object.entries(this.resource.tokens)) {
      if (token.startsWith("font.")) {
        const font = this.ctx.resolveRef(value, isFont, () => `'tokens.${token}' of Ui.Theme '${name}'`, "Font.Family");
        provided.fonts[token] = { family: font.family, faces: font.faces };
      } else {
        provided.tokens[token] = String(value);
      }
    }
    return provided;
  }
}

export async function create(resource: ThemeResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Theme(resource, ctx);
}
