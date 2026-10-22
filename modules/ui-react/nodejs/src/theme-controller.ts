import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isControlSet, type ControlSetInstance, type ProvidedControls } from "./controls-controller.js";
import type { ProvidedTokens } from "./tokens-stylesheet.js";

type ThemeResource = RuntimeResource & { tokens?: unknown; stylesheets?: string[]; controls?: unknown[] };

/**
 * What a `UiReact.Theme` provides: its token values, its stylesheets as
 * absolute paths on this host, in order, and each control set resolved — all a
 * host needs to apply the theme without resolving anything of another module.
 */
export interface ProvidedTheme {
  /** `UiReact.Theme '<name>'`. */
  owner: string;
  tokens?: ProvidedTokens;
  stylesheets: string[];
  controls: ProvidedControls[];
}

const providesTokens = (candidate: unknown): candidate is { provide(): Promise<ProvidedTokens> } =>
  typeof (candidate as { provide?: unknown } | null)?.provide === "function";

class Theme implements ResourceInstance {
  private resolved?: Promise<ProvidedTheme>;

  constructor(
    private readonly resource: ThemeResource,
    private readonly ctx: ResourceContext,
    private readonly owner: string,
    private readonly sets: ControlSetInstance[],
  ) {}

  provide(): Promise<ProvidedTheme> {
    this.resolved ??= this.resolve();
    return this.resolved;
  }

  private async resolve(): Promise<ProvidedTheme> {
    const tokens =
      this.resource.tokens === undefined
        ? undefined
        : await this.ctx
            .resolveRef(this.resource.tokens, providesTokens, () => `'tokens' of ${this.owner}`, "Ui.DesignTokens")
            .provide();
    return {
      owner: this.owner,
      ...(tokens === undefined ? {} : { tokens }),
      stylesheets: [...(this.resource.stylesheets ?? [])],
      controls: await Promise.all(this.sets.map((set) => set.provide())),
    };
  }
}

export async function create(resource: ThemeResource, ctx: ResourceContext): Promise<ResourceInstance> {
  const owner = `UiReact.Theme '${resource.metadata.name}'`;
  const sets = (resource.controls ?? []).map((value, index) =>
    ctx.resolveRef(value, isControlSet, () => `'controls[${index}]' of ${owner}`, "UiReact.Controls"),
  );
  // Entries are counted, not instances: one set listed through two aliases is two entries.
  const implementer = new Map<string, number>();
  sets.forEach((set, index) => {
    for (const control of set.implements) {
      const first = implementer.get(control);
      if (first !== undefined) {
        throw new RuntimeError(
          "ERR_UI_THEME_CONTROL_DUPLICATE",
          `${owner}: 'controls[${index}]' (${set.owner}) implements '${control}', which 'controls[${first}]' (${sets[first].owner}) already implements. Give each control one implementation.`,
        );
      }
      implementer.set(control, index);
    }
  });
  return new Theme(resource, ctx, owner, sets);
}
