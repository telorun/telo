import {
  canonicalTypeSchemaId,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
  type TextRecord,
} from "@telorun/sdk";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { DEFAULT_FAILURE, NOTHING } from "./request-failure.js";
import { enteredFields, type GroupConfig, type GroupSpec } from "./entered-fields.js";
import type { FieldSpec } from "./field-answer.js";
import { modelSchema, modelShape, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import type { Binding, Condition } from "./row-binding.js";
import { stateSpec, type StateConfig } from "./state-record.js";

type ActionResource = RuntimeResource & {
  inputModel: unknown;
  outputModel?: unknown;
  source: { path: string };
  label: TextRecord;
  fields?: unknown[] | null;
  groups?: GroupConfig[] | null;
  state?: StateConfig | null;
  enabled?: (Condition & { disabledText: unknown }) | null;
  result?: AuthoredNode | null;
  failure?: AuthoredNode | null;
  onSuccess?: { navigate?: Binding | null; refreshes?: string[] | null } | null;
  concurrency?: "parallel" | "serial" | null;
  clearAnswerOn?: string[] | null;
};

/** What whoever runs an action from a row needs of it before it is provided. */
export interface Operation {
  /** The input model. */
  schema: JsonSchema;
  /** The fields and groups its form shows, read when something shows them. */
  fields(): Promise<{ fields: FieldSpec[]; groups: GroupSpec[] }>;
}

export interface ActionInstance {
  operation(): Operation;
  provide(): Promise<Provided>;
}

export function isAction(candidate: unknown): candidate is ActionInstance {
  const action = candidate as ActionInstance | null;
  return typeof action?.operation === "function" && typeof action.provide === "function";
}

class Action implements ResourceInstance, ActionInstance {
  private readonly owner: string;

  constructor(
    private readonly resource: ActionResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `Ui.Action '${resource.metadata.name}'`;
  }

  operation(): Operation {
    const schema = modelSchema(this.resource.inputModel, this.ctx, this.owner, "inputModel");
    return {
      schema,
      fields: () => enteredFields(schema, this.resource.fields, this.resource.groups, this.ctx, this.owner, "inputModel"),
    };
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const { schema, fields: entered } = this.operation();
    const { fields, groups } = await entered();
    const state = await stateSpec(resource.state, fields.map((field) => field.property), schema, this.ctx, this.owner, "state", "field");
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [index, property] of (resource.clearAnswerOn ?? []).entries()) {
      if (!Object.hasOwn(properties, property)) {
        throw new RuntimeError(
          "ERR_UI_ACTION_CLEAR_UNKNOWN_PROPERTY",
          `${this.owner}: 'clearAnswerOn[${index}]' clears its answer on a property the input model does not declare ('${property}'), which never changes. Use a property of 'inputModel', or remove this entry.`,
        );
      }
    }
    const reader = { ctx: this.ctx, owner: this.owner };
    const answer = resource.outputModel == null ? undefined : modelSchema(resource.outputModel, this.ctx, this.owner, "outputModel");
    const input = modelShape(schema, reader, "inputModel");
    const result = answer
      ? modelShape(answer, reader, "outputModel")
      : modelShape({ type: "object", properties: {}, additionalProperties: false }, reader, "outputModel");
    const error = modelShape({ $ref: canonicalTypeSchemaId("Ui", "RequestError") }, reader, "failure");
    const drawn =
      resource.result == null
        ? undefined
        : ((await resolveNode(resource.result, this.ctx, `${this.owner} result`, { result, input, values: input })) ?? {
            node: NOTHING,
            assets: [],
          });
    const failure = (await resolveNode(resource.failure ?? DEFAULT_FAILURE, this.ctx, `${this.owner} failure`, {
      error,
      input,
      values: input,
    })) ?? { node: NOTHING, assets: [] };
    const navigate = resource.onSuccess?.navigate;
    const node: SpecNode = {
      type: "action",
      schema,
      path: resource.source.path,
      label: resource.label,
      fields,
      groups,
      state,
      ...(resource.enabled != null ? { enabled: resource.enabled } : {}),
      ...(answer ? { answer } : {}),
      ...(drawn ? { result: drawn.node ?? NOTHING } : {}),
      failure: failure.node ?? NOTHING,
      onSuccess: {
        ...(navigate != null ? { navigate } : {}),
        refreshes: resource.onSuccess?.refreshes ?? [],
      },
      concurrency: resource.concurrency ?? "parallel",
      clearAnswerOn: resource.clearAnswerOn ?? [],
    };
    return { node, assets: mergeAssets(drawn?.assets ?? [], failure.assets) };
  }
}

export async function create(resource: ActionResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Action(resource, ctx);
}
