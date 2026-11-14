import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import { buttonSpec, providedButton, type ButtonDisplay, type ButtonSpec } from "./button-display.js";
import type { AssetFile, SpecNode } from "./composite.js";
import { isStateStore, type StateStoreSpec } from "./state-store.js";
import { drawerSpec, isSurface, type SurfaceSpec } from "./surface-spec.js";

/** A `Ui.Aside` as written. A member holding nothing is one left out. */
export interface AsideConfig {
  side?: "start" | "end" | null;
  size?: "small" | "medium" | "large" | null;
  frame?: "framed" | "flush" | null;
  toggle?: unknown;
  label: unknown;
  collapse?: { collapsed?: boolean | null; state?: KeptStateConfig | null } | null;
  compact?: unknown;
  actions?: unknown[] | null;
  content: unknown;
}

/** Where a piece of chrome keeps what the viewer chose, as written. */
export interface KeptStateConfig {
  key: string;
  store: unknown;
}

/** Where a piece of chrome keeps what the viewer chose, as a renderer
 *  receives it; null keeps it in memory. */
export type KeptState = { key: string; store: StateStoreSpec } | null;

/** Everything of an aside as a renderer receives it but what it holds. */
export interface AsideFrame {
  side: "start" | "end";
  size: "small" | "medium" | "large";
  frame: "framed" | "flush";
  toggle: ButtonSpec;
  label: unknown;
  collapse: { collapsed: boolean; state: KeptState } | null;
  compact: SurfaceSpec;
}

/** An aside as a renderer receives it, every member present. */
export interface AsideSpec extends AsideFrame {
  actions: SpecNode[];
  content: SpecNode;
}

/** A kept state as a renderer receives it: its store provided, or null. */
export async function keptState(state: KeptStateConfig | null | undefined, ctx: ResourceContext, describe: () => string): Promise<KeptState> {
  if (state == null) return null;
  return { key: state.key, store: await ctx.resolveRef(state.store, isStateStore, describe, "Ui.StateStore").provide() };
}

/**
 * The one filling of an aside, for a split view and a page layout alike: every
 * member but what it holds, a member left out given its default — the start
 * edge, a medium column, a flush frame, a glyph of the look's own for the
 * toggle, no fold, and a drawer from the aside's side — and the file of the
 * toggle's glyph. A compact surface declaring an address or a compact surface
 * of its own is refused: an aside has no address to stand in for, and one
 * level applies.
 */
export async function asideFrame(aside: AsideConfig, ctx: ResourceContext, owner: string, at: string): Promise<{ frame: AsideFrame; assets: AssetFile[] }> {
  const side = aside.side ?? "start";
  const display: ButtonDisplay =
    aside.toggle == null ? { type: "icon", icon: null, label: "hidden" } : await providedButton(aside.toggle, ctx, () => `'${at}.toggle' of ${owner}`);
  const toggle = await buttonSpec(display, owner, `${at}.toggle.icon`);
  const collapse =
    aside.collapse == null
      ? null
      : {
          collapsed: aside.collapse.collapsed ?? false,
          state: await keptState(aside.collapse.state, ctx, () => `'${at}.collapse.state.store' of ${owner}`),
        };
  return {
    frame: {
      side,
      size: aside.size ?? "medium",
      frame: aside.frame ?? "flush",
      toggle: toggle.spec,
      label: aside.label,
      collapse,
      compact: await compactSurface(aside.compact, ctx, owner, at, side),
    },
    assets: toggle.assets,
  };
}

/** The surface an aside becomes: the one written, else a drawer from the aside's side. */
async function compactSurface(written: unknown, ctx: ResourceContext, owner: string, at: string, side: string): Promise<SurfaceSpec> {
  if (written == null) return drawerSpec({ side });
  const surface = await ctx.resolveRef(written, isSurface, () => `'${at}.compact' of ${owner}`, "Ui.ViewportOverlay").provide();
  if (surface.address !== undefined) {
    throw new RuntimeError(
      "ERR_UI_SURFACE_COMPACT_ADDRESSED",
      `${owner}: '${at}.compact' names a compact surface that declares an address. The aside has no address of its own to stand in for: remove 'address' from it.`,
    );
  }
  if (surface.compact !== undefined) {
    throw new RuntimeError(
      "ERR_UI_SURFACE_COMPACT_NESTED",
      `${owner}: '${at}.compact' names a compact surface that declares a compact surface of its own. Only one level applies: remove 'compact' from it.`,
    );
  }
  return surface;
}
