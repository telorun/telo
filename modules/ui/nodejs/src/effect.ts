import type { ResourceContext } from "@telorun/sdk";
import type { DestinationSpec } from "./destination.js";
import type { MutationSpec } from "./mutation-controller.js";
import type { PressSpec } from "./press.js";
import type { Binding } from "./row-binding.js";

/** How a notification is announced and how long it stays. */
export type ToastTone = "info" | "success" | "warning" | "danger";

/** A mutation run by a press, as a renderer receives it: every member present. */
export interface MutationPressSpec {
  mutation: MutationSpec;
  inputs: Record<string, Binding>;
  label: unknown;
  onSuccess: EffectSpec[];
  onFailure: EffectSpec[];
}

/** A notification, its `tone` filled by the list holding it. */
export interface ToastSpec {
  type: "toast";
  text: unknown;
  tone: ToastTone;
  link?: PressSpec;
  call?: MutationPressSpec;
}

/** What a toast provides before the list holding it fills its tone. */
export type ToastDraft = Omit<ToastSpec, "tone"> & { tone?: ToastTone };

/** The closing of the surface a call ran in. */
export interface CloseSpec {
  type: "close";
}

/** What follows an answer, as a renderer receives it: one branch per kind of effect. */
export type EffectSpec = DestinationSpec | ToastSpec | CloseSpec;

export interface EffectInstance {
  provide(): Promise<DestinationSpec | ToastDraft | CloseSpec>;
}

/** Whether a value is an effect instance: anything providing a spec. */
export function isEffect(candidate: unknown): candidate is EffectInstance {
  return typeof (candidate as EffectInstance | null)?.provide === "function";
}

/** The list a toast is written in decides the tone it takes when it names none. */
export type ListTone = "success" | "danger";

/** The spec of the effect a list entry holds. */
export async function effectAt(value: unknown, ctx: ResourceContext, describe: () => string, tone: ListTone): Promise<EffectSpec> {
  const spec = await ctx.resolveRef(value, isEffect, describe, "Ui.Effect").provide();
  return spec.type === "toast" ? { ...spec, tone: spec.tone ?? tone } : spec;
}

/** The specs of the effects an `onSuccess` or `onFailure` list holds, in order. */
export async function effectsAt(
  values: readonly unknown[] | null | undefined,
  tone: ListTone,
  ctx: ResourceContext,
  owner: string,
  list: string,
): Promise<EffectSpec[]> {
  const specs: EffectSpec[] = [];
  for (const [index, effect] of (values ?? []).entries()) {
    specs.push(await effectAt(effect, ctx, () => `'${list}[${index}]' of ${owner}`, tone));
  }
  return specs;
}
