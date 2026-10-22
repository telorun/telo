import { RuntimeError, type BrowserEntryFiles, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import contract from "./contract/controls.json" with { type: "json" };

/** The controls drawing a layer, which a set implements all of or none of. */
const LAYER_CONTROLS = Object.entries(contract.controls as Record<string, { layer?: true }>)
  .filter(([, control]) => control.layer === true)
  .map(([name]) => name);

type ControlsResource = RuntimeResource & { entry: string; implements: string[] };

/**
 * What a `UiReact.Controls` set provides: its browser entry resolved to the
 * files a host serves or loads — the entry file, its siblings, their digest and
 * its exports — and the controls it implements. Resolved here, against the
 * module that declared the set, so no host resolves another module's entries.
 */
export interface ProvidedControls {
  /** `UiReact.Controls '<name>'`. */
  owner: string;
  files: BrowserEntryFiles;
  implements: string[];
}

/** A control set as a theme holds it: what it implements is known when it is created. */
export interface ControlSetInstance {
  readonly owner: string;
  readonly implements: readonly string[];
  provide(): Promise<ProvidedControls>;
}

export function isControlSet(candidate: unknown): candidate is ControlSetInstance {
  const set = candidate as ControlSetInstance | null;
  return typeof set?.provide === "function" && Array.isArray(set.implements) && typeof set.owner === "string";
}

class ControlSet implements ResourceInstance, ControlSetInstance {
  readonly owner: string;
  readonly implements: readonly string[];
  private resolved?: Promise<ProvidedControls>;

  constructor(
    private readonly resource: ControlsResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `UiReact.Controls '${resource.metadata.name}'`;
    this.implements = resource.implements;
  }

  provide(): Promise<ProvidedControls> {
    this.resolved ??= this.ctx
      .resolveBrowserEntry(this.resource.entry)
      .then((files) => ({ owner: this.owner, files, implements: [...this.implements] }));
    return this.resolved;
  }
}

export async function create(resource: ControlsResource, ctx: ResourceContext): Promise<ResourceInstance> {
  const implemented = LAYER_CONTROLS.filter((name) => resource.implements.includes(name));
  if (implemented.length > 0 && implemented.length < LAYER_CONTROLS.length) {
    const missing = LAYER_CONTROLS.filter((name) => !implemented.includes(name));
    throw new RuntimeError(
      "ERR_UI_CONTROLS_LAYERS_PARTIAL",
      `UiReact.Controls '${resource.metadata.name}': implements the layer controls ${implemented.join(", ")} but not ${missing.join(", ")}. A set implementing any of the eight layer controls implements all of them.`,
    );
  }
  return new ControlSet(resource, ctx);
}
