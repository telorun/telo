import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import { isAction, type ActionInstance } from "./action-controller.js";
import type { AssetFile, SpecNode } from "./composite.js";
import type { JsonSchema } from "./model-schema.js";
import { isChain, type Binding, type Condition } from "./row-binding.js";

/** A `Ui.RowAction` as written. A member holding nothing is one left out. */
export interface RowActionConfig {
  action: unknown;
  inputs: Record<string, Binding>;
  confirm?: unknown;
  prompt?: boolean | null;
  enabled?: (Condition & { disabledText: unknown }) | null;
}

/** A row action as a renderer receives it, its `action` still the instance
 *  until whoever places it provides it. */
export interface PendingRowAction {
  action: ActionInstance;
  inputs: Record<string, Binding>;
  confirm?: unknown;
  /** Whether a press opens a dialog asking for the fields the inputs do not bind. */
  prompt: boolean;
  enabled?: Condition & { disabledText: unknown };
}

/** Why a row's inputs cannot make a record of the action's input model: a key
 *  a closed model does not declare, a required input left unbound, a fixed
 *  value its property refuses. A path into the row is typed by `telo check`
 *  alone. */
function rowActionInputProblems(schema: JsonSchema, inputs: Record<string, Binding>, ctx: ResourceContext): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const problems: string[] = [];
  for (const [name, binding] of Object.entries(inputs)) {
    if (!Object.hasOwn(properties, name)) {
      if (schema.additionalProperties === false) problems.push(`'${name}' is not a property of the action's input model`);
      continue;
    }
    if (isChain(binding)) continue;
    // Beside the model's own definitions, which the property may reference.
    const validator = ctx.createSchemaValidator({
      allOf: [properties[name]],
      $defs: schema.$defs,
      definitions: schema.definitions,
    });
    try {
      validator.validate(binding.value);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      problems.push(`'${name}' holds a value its property refuses (${error.message})`);
    }
  }
  for (const required of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
    if (!Object.hasOwn(inputs, required)) problems.push(`required input '${required}' is not bound`);
  }
  return problems;
}

/**
 * A row action held to its action: the inputs make a record of its input
 * model, and the fields a prompt asks for are the action's own the row does
 * not bind. `where` names the entry, `owner` the resource writing it.
 */
export function pendingRowAction(entry: RowActionConfig, ctx: ResourceContext, owner: string, where: string): PendingRowAction {
  const action = ctx.resolveRef(entry.action, isAction, () => `'${where}.action' of ${owner}`, "Ui.Action");
  const problems = rowActionInputProblems(action.operation().schema, entry.inputs, ctx);
  if (problems.length > 0) {
    throw new RuntimeError(
      "ERR_UI_ROW_ACTION_INPUTS_INVALID",
      `${owner}: '${where}.inputs' cannot make a record of the action's input model: ${problems.join("; ")}.`,
    );
  }
  return {
    action,
    inputs: entry.inputs,
    ...(entry.confirm != null ? { confirm: entry.confirm } : {}),
    prompt: entry.prompt === true,
    ...(entry.enabled != null ? { enabled: entry.enabled } : {}),
  };
}

/**
 * A row action as a renderer receives it, its action placed as the node it
 * provided: a prompt asks for the action's fields the row's inputs do not
 * bind. Whoever places a pending row action — a composite, a page — places it
 * through this, so a prompt reads the same everywhere.
 */
export function placedRowAction(
  { prompt, action, ...entry }: Omit<PendingRowAction, "action"> & { action?: unknown },
  node: SpecNode,
): Record<string, unknown> {
  const fields = (Array.isArray(node.fields) ? node.fields : []) as { property: string }[];
  // The row's inputs are sent as bound; the dialog enters the rest.
  const asked = prompt === true ? { prompt: { fields: fields.filter((field) => !Object.hasOwn(entry.inputs, field.property)) } } : {};
  return { ...entry, ...asked, action: node };
}

/** Row actions with each action provided, and the files their trees need. */
export async function providedRowActions(
  pending: PendingRowAction[],
): Promise<{ rowActions: Record<string, unknown>[]; assets: AssetFile[][] }> {
  const rowActions: Record<string, unknown>[] = [];
  const assets: AssetFile[][] = [];
  for (const entry of pending) {
    const provided = await entry.action.provide();
    assets.push(provided.assets);
    rowActions.push(placedRowAction(entry, provided.node as SpecNode));
  }
  return { rowActions, assets };
}
