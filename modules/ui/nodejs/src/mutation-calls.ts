import { canonicalTypeSchemaId, RuntimeError, type ResourceContext } from "@telorun/sdk";
import { effectAt, type EffectSpec } from "./effect.js";
import { mergeAssets, type AssetFile, type SpecNode } from "./composite.js";
import { filledNode } from "./fill-marking.js";
import { isMutation, type MutationSpec } from "./mutation-controller.js";
import { modelShape, type JsonSchema } from "./model-schema.js";
import { nodeLists, resolveNode, type AuthoredNode } from "./node-resolution.js";
import { isPrompt, type PromptSpec } from "./prompt-controller.js";
import { DEFAULT_FAILURE, NOTHING } from "./request-failure.js";
import { isChain, type Binding, type Condition } from "./row-binding.js";

/** A `Ui.MutationCall` or `Ui.Move` as written. A member holding nothing is one left out. */
export interface MutationCallConfig {
  mutation: unknown;
  inputs: Record<string, Binding>;
  label?: unknown;
  confirm?: unknown;
  prompt?: unknown;
  enabled?: (Condition & { disabledText: unknown }) | null;
  onSuccess?: unknown[] | null;
  result?: AuthoredNode | null;
  failure?: AuthoredNode | null;
}

/** Which closed shape a holder writes: a call has a label and a result, a move neither. */
export type CallShape = "call" | "move";

/** What a call's answer is made of, provided once at start. */
export interface AnsweredCall {
  mutation: MutationSpec;
  prompt: PromptSpec | null;
  onSuccess: EffectSpec[];
  result?: SpecNode;
  failure: SpecNode;
}

interface ProvidedAnswer {
  node: AnsweredCall;
  assets: AssetFile[];
}

/** A call as a renderer receives it, its mutation, prompt, effects and trees
 *  still to be provided by whoever places it. */
export interface PendingMutationCall {
  call: { provide(): Promise<ProvidedAnswer> };
  inputs: Record<string, Binding>;
  label?: unknown;
  confirm?: unknown;
  enabled?: Condition & { disabledText: unknown };
}

/** The members of a call that stay beside its provided answer. */
const KEPT_MEMBERS = ["inputs", "label", "confirm", "enabled"] as const;

type NodeLike = { type: string; [key: string]: unknown };

/** A `markdown` node's annotations, where it has them. */
const annotationsOf = (node: NodeLike): Record<string, unknown> | undefined =>
  node.type === "markdown" && node.annotations !== null && typeof node.annotations === "object"
    ? (node.annotations as Record<string, unknown>)
    : undefined;

/** The calls a node holds, in order: a `list` node's `rowActions`, a `button`
 *  node's `action`, a `markdown` node's `annotations.action`. */
export function mutationCallsOf(node: NodeLike): Record<string, unknown>[] {
  if (node.type === "list") return Array.isArray(node.rowActions) ? (node.rowActions as Record<string, unknown>[]) : [];
  const annotations = annotationsOf(node);
  if (annotations) return annotations.action == null ? [] : [annotations.action as Record<string, unknown>];
  if (node.type === "button") return node.action == null ? [] : [node.action as Record<string, unknown>];
  return [];
}

/** Where in a node each of its calls is written, for what is refused. */
export function mutationCallPlaces(node: NodeLike): string[] {
  if (node.type === "button") return ["action"];
  if (node.type === "markdown") return ["annotations.action"];
  return mutationCallsOf(node).map((_, index) => `rowActions[${index}]`);
}

/** `node` with its calls replaced by `entries`, in the order {@link mutationCallsOf} reads them. */
export function withMutationCalls<T extends NodeLike>(node: T, entries: Record<string, unknown>[]): T {
  if (node.type === "list") return { ...node, rowActions: entries };
  const annotations = annotationsOf(node);
  if (annotations) return { ...node, annotations: { ...annotations, action: entries[0] } };
  if (node.type === "button") return { ...node, action: entries[0] };
  return node;
}

/** Why the inputs cannot make a record of the mutation's input model: a key a
 *  closed model does not declare, a required input left unbound, a fixed value
 *  its property refuses, a read of `prompt` where the call asks nothing. A path
 *  into a root is typed by `telo check` alone. */
function callInputProblems(schema: JsonSchema, inputs: Record<string, Binding>, prompted: boolean, ctx: ResourceContext): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const problems: string[] = [];
  for (const [name, binding] of Object.entries(inputs)) {
    if (!Object.hasOwn(properties, name)) {
      if (schema.additionalProperties === false) problems.push(`'${name}' is not a property of the mutation's input model`);
      continue;
    }
    if (isChain(binding)) {
      if (binding.root === "prompt" && !prompted) problems.push(`'${name}' reads 'prompt', but the call has no prompt`);
      continue;
    }
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

/** `node` with the `when` of every node, tab and menu item it holds evaluated:
 *  a call's trees are resolved once, so each decides delivery here, reading
 *  what exists at creation. */
function withWhensEvaluated<T extends { [key: string]: unknown }>(node: T, ctx: ResourceContext): T {
  const out: Record<string, unknown> = { ...node };
  if (node.when !== undefined) out.when = ctx.expandValue(node.when, { request: null });
  const each = (items: unknown) => (items as T[]).map((item) => withWhensEvaluated(item, ctx));
  for (const list of nodeLists(node as unknown as { type: string })) if (Array.isArray(node[list])) out[list] = each(node[list]);
  for (const member of ["tabs", "items"]) if (Array.isArray(node[member])) out[member] = each(node[member]);
  return out as T;
}

/**
 * A call held to its mutation: the inputs make a record of its input model, and
 * its prompt, effects and trees are resolved. `owner` names the resource or node
 * writing it, `where` the entry within it.
 */
export function pendingMutationCall(
  entry: MutationCallConfig,
  ctx: ResourceContext,
  owner: string,
  where: string | undefined,
  shape: CallShape,
): PendingMutationCall {
  const at = (member: string) => (where === undefined ? member : `${where}.${member}`);
  const mutation = ctx.resolveRef(entry.mutation, isMutation, () => `'${at("mutation")}' of ${owner}`, "Ui.Mutation");
  const spec = mutation.spec();
  const prompt = entry.prompt == null ? null : ctx.resolveRef(entry.prompt, isPrompt, () => `'${at("prompt")}' of ${owner}`, "Ui.Prompt");
  const problems = callInputProblems(spec.schema, entry.inputs, prompt !== null, ctx);
  if (problems.length > 0) {
    throw new RuntimeError(
      "ERR_UI_MUTATION_CALL_INPUTS_INVALID",
      `${owner}: '${at("inputs")}' cannot make a record of the mutation's input model: ${problems.join("; ")}.`,
    );
  }
  const effects = (entry.onSuccess ?? []).map((effect, index) => () => effectAt(effect, ctx, () => `'${at(`onSuccess[${index}]`)}' of ${owner}`));
  const reader = { ctx, owner };
  const call = {
    async provide(): Promise<ProvidedAnswer> {
      const input = modelShape(spec.schema, reader, "inputModel");
      const result = modelShape(
        spec.answer ?? { type: "object", properties: {}, additionalProperties: false },
        reader,
        "outputModel",
      );
      const error = modelShape({ $ref: canonicalTypeSchemaId("Ui", "RequestError") }, reader, "failure");
      const drawn =
        shape === "move" || entry.result == null
          ? undefined
          : ((await resolveNode(withWhensEvaluated(entry.result, ctx), ctx, `${owner} ${at("result")}`, { result, input })) ?? {
              node: NOTHING,
              assets: [],
            });
      const failure = (await resolveNode(
        withWhensEvaluated(entry.failure ?? DEFAULT_FAILURE, ctx),
        ctx,
        `${owner} ${at("failure")}`,
        { error, input },
      )) ?? { node: NOTHING, assets: [] };
      const onSuccess: EffectSpec[] = [];
      for (const effect of effects) onSuccess.push(await effect());
      const node: AnsweredCall = {
        mutation: spec,
        prompt: prompt === null ? null : await prompt.provide(),
        onSuccess,
        ...(drawn ? { result: filledNode(drawn.node ?? NOTHING) } : {}),
        failure: filledNode(failure.node ?? NOTHING),
      };
      return { node, assets: mergeAssets(drawn?.assets ?? [], failure.assets) };
    },
  };
  return {
    call,
    inputs: entry.inputs,
    ...(shape === "call" && entry.label != null ? { label: entry.label } : {}),
    ...(entry.confirm != null ? { confirm: entry.confirm } : {}),
    ...(entry.enabled != null ? { enabled: entry.enabled } : {}),
  };
}

/** A call as a renderer receives it: what it kept beside the answer provided for it. */
export function placedMutationCall(
  entry: Partial<Pick<PendingMutationCall, (typeof KEPT_MEMBERS)[number]>> & { call?: unknown },
  answered: unknown,
): Record<string, unknown> {
  const { call, ...kept } = entry;
  return { ...kept, ...(answered as Record<string, unknown>) };
}

/** Calls provided, and the files their trees need. */
export async function providedMutationCalls(
  pending: PendingMutationCall[],
): Promise<{ entries: Record<string, unknown>[]; assets: AssetFile[][] }> {
  const entries: Record<string, unknown>[] = [];
  const assets: AssetFile[][] = [];
  for (const entry of pending) {
    const provided = await entry.call.provide();
    assets.push(provided.assets);
    entries.push(placedMutationCall(entry, provided.node));
  }
  return { entries, assets };
}

/** What a form's `onSubmit` or `autosave` is as written. */
export interface FormWriteConfig {
  mutation: unknown;
  inputs: Record<string, Binding>;
  label?: unknown;
  confirm?: unknown;
  enabled?: (Condition & { disabledText: unknown }) | null;
  debounce?: unknown;
  result?: AuthoredNode | null;
  failure?: AuthoredNode | null;
}

/** A form's write, its mutation spec and its trees provided; the members that
 *  belong to which write are added by the form. */
export interface ProvidedFormWrite {
  mutation: MutationSpec;
  inputs: Record<string, Binding>;
  result?: SpecNode;
  failure: SpecNode;
  assets: AssetFile[];
}

/**
 * A write a form runs: the inputs held to its mutation's input model, its
 * answer trees resolved with `values` — what the form holds — beside `result`
 * and `input`. `where` is the member of the form writing it.
 */
export async function formWrite(
  entry: FormWriteConfig,
  ctx: ResourceContext,
  owner: string,
  where: "onSubmit" | "autosave",
  values: JsonSchema,
): Promise<ProvidedFormWrite> {
  const mutation = ctx.resolveRef(entry.mutation, isMutation, () => `'${where}.mutation' of ${owner}`, "Ui.Mutation");
  const spec = mutation.spec();
  const problems = callInputProblems(spec.schema, entry.inputs, false, ctx);
  if (problems.length > 0) {
    throw new RuntimeError(
      "ERR_UI_MUTATION_CALL_INPUTS_INVALID",
      `${owner}: '${where}.inputs' cannot make a record of the mutation's input model: ${problems.join("; ")}.`,
    );
  }
  const reader = { ctx, owner };
  const input = modelShape(spec.schema, reader, "inputModel");
  const held = modelShape(values, reader, "model");
  const result = modelShape(spec.answer ?? { type: "object", properties: {}, additionalProperties: false }, reader, "outputModel");
  const error = modelShape({ $ref: canonicalTypeSchemaId("Ui", "RequestError") }, reader, "failure");
  const drawn =
    entry.result == null
      ? undefined
      : ((await resolveNode(withWhensEvaluated(entry.result, ctx), ctx, `${owner} ${where}.result`, {
          result,
          input,
          values: held,
        })) ?? { node: NOTHING, assets: [] });
  const failure = (await resolveNode(
    withWhensEvaluated(entry.failure ?? DEFAULT_FAILURE, ctx),
    ctx,
    `${owner} ${where}.failure`,
    { error, input, values: held },
  )) ?? { node: NOTHING, assets: [] };
  return {
    mutation: spec,
    inputs: entry.inputs,
    ...(drawn ? { result: filledNode(drawn.node ?? NOTHING) } : {}),
    failure: filledNode(failure.node ?? NOTHING),
    assets: mergeAssets(drawn?.assets ?? [], failure.assets),
  };
}
