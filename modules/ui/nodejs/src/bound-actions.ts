import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import { isAction, type ActionInstance } from "./action-controller.js";
import type { AssetFile, SpecNode } from "./composite.js";
import type { JsonSchema } from "./model-schema.js";
import { isChain, type Binding, type Condition } from "./row-binding.js";

/** A `Ui.BoundAction` as written. A member holding nothing is one left out. */
export interface BoundActionConfig {
  action: unknown;
  inputs: Record<string, Binding>;
  confirm?: unknown;
  prompt?: boolean | null;
  enabled?: (Condition & { disabledText: unknown }) | null;
}

/** A bound action as a renderer receives it, its `action` still the instance
 *  until whoever places it provides it. */
export interface PendingBoundAction {
  action: ActionInstance;
  inputs: Record<string, Binding>;
  confirm?: unknown;
  /** Whether a press opens a dialog asking for the fields the inputs do not bind. */
  prompt: boolean;
  enabled?: Condition & { disabledText: unknown };
}

/** The members of a `button` node that are its bound action. */
const BOUND_MEMBERS = ["action", "inputs", "confirm", "prompt", "enabled"] as const;

type NodeLike = { type: string; [key: string]: unknown };

/** A `markdown` node's annotations, where it has them. */
const annotationsOf = (node: NodeLike): Record<string, unknown> | undefined =>
  node.type === "markdown" && node.annotations !== null && typeof node.annotations === "object"
    ? (node.annotations as Record<string, unknown>)
    : undefined;

/** The bound actions a node holds, in order: a `list` node's `rowActions`, a
 *  `button` node's own members, a `markdown` node's `annotations.action`. */
export function boundActionsOf(node: NodeLike): Record<string, unknown>[] {
  if (node.type === "list") return Array.isArray(node.rowActions) ? (node.rowActions as Record<string, unknown>[]) : [];
  const annotations = annotationsOf(node);
  if (annotations) return annotations.action == null ? [] : [annotations.action as Record<string, unknown>];
  if (node.type === "button") {
    const entry: Record<string, unknown> = {};
    for (const member of BOUND_MEMBERS) if (node[member] !== undefined && node[member] !== null) entry[member] = node[member];
    return [entry];
  }
  return [];
}

/** Where in a node each of its bound actions is written, for what is refused. */
export function boundActionPlaces(node: NodeLike): (string | undefined)[] {
  if (node.type === "button") return [undefined];
  if (node.type === "markdown") return ["annotations.action"];
  return boundActionsOf(node).map((_, index) => `rowActions[${index}]`);
}

/** `node` with its bound actions replaced by `entries`, in the order {@link boundActionsOf} reads them. */
export function withBoundActions<T extends NodeLike>(node: T, entries: Record<string, unknown>[]): T {
  if (node.type === "list") return { ...node, rowActions: entries };
  const annotations = annotationsOf(node);
  if (annotations) return { ...node, annotations: { ...annotations, action: entries[0] } };
  if (node.type === "button") {
    const rest: NodeLike = { type: node.type };
    for (const [key, value] of Object.entries(node)) if (!(BOUND_MEMBERS as readonly string[]).includes(key)) rest[key] = value;
    return { ...rest, ...entries[0] } as T;
  }
  return node;
}

/** Why the inputs cannot make a record of the action's input model: a key a
 *  closed model does not declare, a required input left unbound — unless the
 *  press prompts for what is left — a fixed value its property refuses. A path
 *  into a root is typed by `telo check` alone. */
function boundInputProblems(schema: JsonSchema, inputs: Record<string, Binding>, prompted: boolean, ctx: ResourceContext): string[] {
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
  // A prompt asks the person for every unbound input the action's form enters.
  if (prompted) return problems;
  for (const required of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
    if (!Object.hasOwn(inputs, required)) problems.push(`required input '${required}' is not bound`);
  }
  return problems;
}

/**
 * A bound action held to its action: the inputs make a record of its input
 * model, and the fields a prompt asks for are the action's own the inputs do
 * not bind. `owner` names the resource or node writing it, `where` the entry
 * within it (none for a `button` node, whose members are the entry).
 */
export function pendingBoundAction(entry: BoundActionConfig, ctx: ResourceContext, owner: string, where?: string): PendingBoundAction {
  const at = (member: string) => (where === undefined ? member : `${where}.${member}`);
  const action = ctx.resolveRef(entry.action, isAction, () => `'${at("action")}' of ${owner}`, "Ui.Action");
  const problems = boundInputProblems(action.operation().schema, entry.inputs, entry.prompt === true, ctx);
  if (problems.length > 0) {
    throw new RuntimeError(
      "ERR_UI_BOUND_ACTION_INPUTS_INVALID",
      `${owner}: '${at("inputs")}' cannot make a record of the action's input model: ${problems.join("; ")}.`,
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
 * A bound action as a renderer receives it, its action placed as the node it
 * provided: a prompt asks for the action's fields the inputs do not bind.
 * Whoever places a pending bound action — a composite, a page — places it
 * through this, so a prompt reads the same everywhere.
 */
export function placedBoundAction(
  { prompt, action, ...entry }: Omit<PendingBoundAction, "action"> & { action?: unknown },
  node: SpecNode,
): Record<string, unknown> {
  const fields = (Array.isArray(node.fields) ? node.fields : []) as { property: string }[];
  // The bound inputs are sent as bound; the dialog enters the rest.
  const asked = prompt === true ? { prompt: { fields: fields.filter((field) => !Object.hasOwn(entry.inputs, field.property)) } } : {};
  return { ...entry, ...asked, action: node };
}

/** Bound actions with each action provided, and the files their trees need. */
export async function providedBoundActions(
  pending: PendingBoundAction[],
): Promise<{ entries: Record<string, unknown>[]; assets: AssetFile[][] }> {
  const entries: Record<string, unknown>[] = [];
  const assets: AssetFile[][] = [];
  for (const entry of pending) {
    const provided = await entry.action.provide();
    assets.push(provided.assets);
    entries.push(placedBoundAction(entry, provided.node as SpecNode));
  }
  return { entries, assets };
}
