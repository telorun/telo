import type { ResourceContext } from "@telorun/sdk";
import { destinationAt, type DestinationSpec } from "./destination.js";

/** A `Ui.Press` as its author wrote it, its destination still a reference. */
export interface PressConfig {
  to: unknown;
  label: unknown;
}

/** What pressing a region or a record does, as a renderer receives it: where it
 *  goes, and the text naming it as written — a text, or one with its values. */
export interface PressSpec {
  to: DestinationSpec;
  label: unknown;
}

/** The node types a press is written on. */
const PRESSABLE: ReadonlySet<string> = new Set(["box", "stack", "columns"]);

export function isPressable(type: string): boolean {
  return PRESSABLE.has(type);
}

/** The wire form of the press `owner` holds; null when it holds none. */
export async function pressSpec(press: PressConfig | null | undefined, ctx: ResourceContext, owner: string): Promise<PressSpec | null> {
  if (press == null) return null;
  return { to: await destinationAt(press.to, ctx, () => `'press.to' of ${owner}`), label: press.label };
}
