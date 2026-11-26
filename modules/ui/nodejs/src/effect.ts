import type { ResourceContext } from "@telorun/sdk";
import { isDestination, type DestinationSpec } from "./destination.js";

/** What follows a success, as a renderer receives it: today a destination. */
export type EffectSpec = DestinationSpec;

/** The spec of the effect an `onSuccess` entry holds. */
export function effectAt(value: unknown, ctx: ResourceContext, describe: () => string): Promise<EffectSpec> {
  return ctx.resolveRef(value, isDestination, describe, "Ui.Effect").provide();
}
