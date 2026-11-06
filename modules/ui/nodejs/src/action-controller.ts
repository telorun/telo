import {
  canonicalTypeSchemaId,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
  type RuntimeResource,
  type TextRecord,
} from "@telorun/sdk";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import type { AddressSpec } from "./address-expansion.js";
import { mergeAssets, type Provided, type SpecNode } from "./composite.js";
import { DEFAULT_FAILURE, NOTHING } from "./request-failure.js";
import { enteredFields, type GroupConfig, type GroupSpec } from "./entered-fields.js";
import type { FieldSpec } from "./field-answer.js";
import { modelSchema, modelShape, type JsonSchema } from "./model-schema.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";
import type { Condition } from "./row-binding.js";
import { stateSpec, type StateConfig } from "./state-record.js";
import { filledProvided } from "./fill-marking.js";

type RequestMethod = "POST" | "PUT" | "PATCH" | "DELETE";

type ActionResource = RuntimeResource & {
  inputModel: unknown;
  outputModel?: unknown;
  request: { method?: RequestMethod | null; target: AddressConfig };
  label: TextRecord;
  fields?: unknown[] | null;
  groups?: GroupConfig[] | null;
  state?: StateConfig | null;
  enabled?: (Condition & { disabledText: unknown }) | null;
  result?: AuthoredNode | null;
  failure?: AuthoredNode | null;
  onSuccess?: { navigate?: AddressConfig | null; refreshes?: AddressConfig[] | null } | null;
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

/** The input properties a target's parameters read whole (`input.<property>`),
 *  in the input model's order. */
function consumedProperties(target: AddressSpec, properties: string[]): string[] {
  const reads = new Set<string>();
  for (const binding of [...Object.values(target.pathParams), ...Object.values(target.queryParams)]) {
    const chain = binding as { root?: unknown; path?: unknown };
    if (chain.root === "input" && Array.isArray(chain.path) && chain.path.length === 1) reads.add(String(chain.path[0]));
  }
  return properties.filter((property) => reads.has(property));
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
    const method = resource.request.method ?? "POST";
    const target = addressSpec(resource.request.target, this.ctx, `${this.owner} request.target`);
    const consumed = consumedProperties(target, Object.keys(properties));
    if (method === "DELETE") {
      const unsent = Object.keys(properties).filter((property) => !consumed.includes(property));
      if (unsent.length > 0) {
        throw new RuntimeError(
          "ERR_UI_ACTION_INPUT_UNSENT",
          `${this.owner}: a 'DELETE' sends no body, yet its target does not read ${unsent.map((property) => `'${property}'`).join(", ")} of 'inputModel'. Read each in a 'pathParams' or 'queryParams' entry as exactly 'input.<property>', or remove it from 'inputModel'.`,
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
    const onSuccessWhere = `${this.owner} onSuccess`;
    const node: SpecNode = {
      type: "action",
      schema,
      request: { method, target, consumed },
      label: resource.label,
      fields,
      groups,
      state,
      ...(resource.enabled != null ? { enabled: resource.enabled } : {}),
      ...(answer ? { answer } : {}),
      ...(drawn ? { result: drawn.node ?? NOTHING } : {}),
      failure: failure.node ?? NOTHING,
      onSuccess: {
        ...(navigate != null ? { navigate: addressSpec(navigate, this.ctx, `${onSuccessWhere}.navigate`) } : {}),
        refreshes: (resource.onSuccess?.refreshes ?? []).map((refresh, index) =>
          addressSpec(refresh, this.ctx, `${onSuccessWhere}.refreshes[${index}]`),
        ),
      },
      concurrency: resource.concurrency ?? "parallel",
      clearAnswerOn: resource.clearAnswerOn ?? [],
    };
    return filledProvided({ node, assets: mergeAssets(drawn?.assets ?? [], failure.assets) });
  }
}

export async function create(resource: ActionResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Action(resource, ctx);
}
