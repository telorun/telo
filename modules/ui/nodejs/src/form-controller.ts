import { durationMs, RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { presentationAt } from "./collection-presentation.js";
import { effectAt, type EffectSpec } from "./effect.js";
import { enteredFields, type GroupConfig } from "./entered-fields.js";
import { modelSchema } from "./model-schema.js";
import { formWrite, type FormWriteConfig } from "./mutation-calls.js";
import { queryId } from "./query-controller.js";
import type { Binding } from "./row-binding.js";
import { uiText } from "./spec-texts.js";
import { stateSpec, type StateConfig } from "./state-record.js";
import { filledProvided } from "./fill-marking.js";
import { assertWriteShape } from "./write-shape.js";

/** How long typing must pause before an autosave write is sent, when none is written. */
const DEFAULT_DEBOUNCE_MS = 300;

type FormResource = RuntimeResource & {
  model: unknown;
  record?: { presentation: unknown; key?: Binding | null } | null;
  initialValues?: Binding | null;
  unsaved?: string | null;
  afterSubmit?: string | null;
  fields?: unknown[] | null;
  groups?: GroupConfig[] | null;
  state?: StateConfig | null;
  onSubmit?: FormWriteConfig | null;
  autosave?: FormWriteConfig | null;
  onSuccess?: unknown[] | null;
  clearAnswerOn?: string[] | null;
};

class Form implements ResourceInstance {
  constructor(
    private readonly resource: FormResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const owner = `Ui.Form '${this.resource.metadata.name}'`;
    const { record, onSubmit, autosave } = this.resource;
    const schema = modelSchema(this.resource.model, this.ctx, owner);
    const written = record == null ? undefined : await presentationAt(record.presentation, this.ctx, owner);
    const key = record?.key ?? null;
    if (written && record) assertWriteShape(schema, written.collection, key !== null, owner);
    const { fields, groups } = await enteredFields(
      schema,
      this.resource.fields,
      this.resource.groups,
      this.ctx,
      owner,
      "model",
      written?.relations,
    );
    const state = await stateSpec(this.resource.state, fields.map((field) => field.property), schema, this.ctx, owner, "state", "field");
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const [index, property] of (this.resource.clearAnswerOn ?? []).entries()) {
      if (!Object.hasOwn(properties, property)) {
        throw new RuntimeError(
          "ERR_UI_FORM_CLEAR_UNKNOWN_PROPERTY",
          `${owner}: 'clearAnswerOn[${index}]' clears its answers on a property the model does not declare ('${property}'), which never changes. Use a property of 'model', or remove this entry.`,
        );
      }
    }
    const assets: AssetFile[][] = [];
    let submitting: Record<string, unknown> | null = null;
    if (onSubmit != null) {
      const { assets: drawn, ...write } = await formWrite(onSubmit, this.ctx, owner, "onSubmit", schema);
      assets.push(drawn);
      submitting = {
        mutation: write.mutation,
        inputs: write.inputs,
        label: onSubmit.label ?? uiText("save"),
        ...(onSubmit.confirm != null ? { confirm: onSubmit.confirm } : {}),
        ...(onSubmit.enabled != null ? { enabled: onSubmit.enabled } : {}),
        ...(write.result ? { result: write.result } : {}),
        failure: write.failure,
      };
    }
    let saving: Record<string, unknown> | null = null;
    if (autosave != null) {
      const { assets: drawn, ...write } = await formWrite(autosave, this.ctx, owner, "autosave", schema);
      assets.push(drawn);
      if (write.mutation.method === "POST") {
        throw new RuntimeError(
          "ERR_UI_FORM_AUTOSAVE_NOT_IDEMPOTENT",
          `${owner}: 'autosave' runs a mutation whose method is 'POST', which creates a record each time the values settle or a failed write is sent again. Autosave a 'PUT', or a 'PATCH' sending the whole record, or run the 'POST' from 'onSubmit'.`,
        );
      }
      saving = {
        mutation: write.mutation,
        inputs: write.inputs,
        debounce: autosave.debounce == null ? DEFAULT_DEBOUNCE_MS : durationMs(autosave.debounce),
        ...(write.result ? { result: write.result } : {}),
        failure: write.failure,
      };
    }
    const onSuccess: EffectSpec[] = [];
    for (const [index, effect] of (this.resource.onSuccess ?? []).entries()) {
      onSuccess.push(await effectAt(effect, this.ctx, () => `'onSuccess[${index}]' of ${owner}`));
    }
    const node: SpecNode = {
      type: "form",
      id: queryId(this.resource.metadata as Parameters<typeof queryId>[0]),
      schema,
      record: written ? { basePath: written.basePath, key, answer: written.collection.model } : null,
      initialValues: this.resource.initialValues ?? null,
      unsaved: this.resource.unsaved ?? "confirm",
      afterSubmit: this.resource.afterSubmit ?? "close",
      fields,
      groups,
      state,
      onSubmit: submitting,
      autosave: saving,
      onSuccess,
      clearAnswerOn: this.resource.clearAnswerOn ?? [],
    };
    return filledProvided({ node, assets: mergeAssets(...assets) });
  }
}

export async function create(resource: FormResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Form(resource, ctx);
}
