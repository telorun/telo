import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { checkInWindow } from "./conformance-thread.js";
import { CONFORMANCE_WORKER } from "./conformance-worker.js";
import type { CheckedSet } from "./control-sets.js";
import type { Problem } from "./problem.js";
import { rendererEntries } from "./renderer-entries.js";
import type { UnstyledPart } from "./style-coverage.js";
import { loadTokenNames } from "./token-names.js";

type CheckThemeResource = RuntimeResource & { theme: unknown; unstyled?: UnstyledPart[] };

/** What a `UiReact.Theme` provides, as far as a check reads it. */
interface CheckedTheme {
  owner: string;
  tokens?: { tokens: Record<string, unknown>; fonts: Record<string, unknown> };
  stylesheets: string[];
  controls: CheckedSet[];
}

const providesTheme = (candidate: unknown): candidate is { provide(): Promise<CheckedTheme> } =>
  typeof (candidate as { provide?: unknown } | null)?.provide === "function";

/** `UiReactConformance.CheckTheme`: the style half over the theme's scenes, and the behaviour half over each of its sets. */
class CheckTheme implements ResourceInstance<Record<string, never>, { problems: Problem[] }> {
  constructor(
    private readonly resource: CheckThemeResource,
    private readonly ctx: ResourceContext,
    private readonly owner: string,
  ) {}

  async invoke(): Promise<{ problems: Problem[] }> {
    const theme = await this.ctx
      .resolveRef(this.resource.theme, providesTheme, () => `'theme' of ${this.owner}`, "UiReact.Theme")
      .provide();
    const job = {
      [CONFORMANCE_WORKER]: true as const,
      entries: await rendererEntries(this.ctx),
      sets: theme.controls,
      look: {
        stylesheets: theme.stylesheets,
        unstyled: this.resource.unstyled ?? [],
        tokens: {
          names: [...(await loadTokenNames())],
          given: [...Object.keys(theme.tokens?.tokens ?? {}), ...Object.keys(theme.tokens?.fonts ?? {})],
        },
      },
    };
    return { problems: await checkInWindow(job, this.ctx, this.owner) };
  }
}

export async function create(resource: CheckThemeResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new CheckTheme(resource, ctx, `UiReactConformance.CheckTheme '${resource.metadata.name}'`);
}
