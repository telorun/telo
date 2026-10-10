import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { declaredName } from "@telorun/graph";
import { actorOf, baseLimit, baseRevisionConflict } from "./draft-operations.js";
import { basesValue, layerNotFound, resolveRevisionedStore } from "./revision-operations.js";
import {
  isRevisionLabel,
  type BasePinRequest,
  type BasesMoved,
  type RevisionedGraphStore,
} from "./revisioned-graph-store.js";

interface BaseOperationManifest {
  metadata: { name: string; module?: string };
  store?: unknown;
}

type Inputs = Record<string, unknown>;

type BaseCall = (
  describe: string,
  store: RevisionedGraphStore,
  inputs: Inputs,
  ctx: InvokeContext | undefined,
) => Promise<Record<string, unknown>>;

class BaseOperation implements ResourceInstance<Inputs, Record<string, unknown>> {
  constructor(
    private readonly describe: string,
    private readonly store: RevisionedGraphStore,
    private readonly call: BaseCall,
  ) {}

  invoke(inputs: Inputs, ctx?: InvokeContext): Promise<Record<string, unknown>> {
    return this.call(this.describe, this.store, inputs ?? {}, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function baseOperation(kind: string, call: BaseCall) {
  return {
    register(): void {},
    async create(resource: BaseOperationManifest, ctx: ResourceContext): Promise<BaseOperation> {
      const describe = `GraphLayers.${kind} "${resource.metadata.name}"`;
      return new BaseOperation(describe, resolveRevisionedStore(resource.store, ctx, describe), call);
    },
  };
}

/** A whole number an input holds: an int64 from CEL or a plain integer. */
function wholeNumber(describe: string, field: string, value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${describe}: '${field}' must be a whole number, got ${String(value)}.`);
}

function layerName(describe: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${describe}: '${field}' must be a layer name.`);
  }
  return value;
}

function pinRequest(describe: string, value: unknown, index: number): BasePinRequest {
  const entry = (value ?? {}) as Inputs;
  const at = `bases[${index}]`;
  const layer = layerName(describe, `${at}.layer`, entry.layer);
  let revision: bigint | string | undefined;
  if (typeof entry.revision === "string") {
    if (!isRevisionLabel(entry.revision)) {
      throw new Error(`${describe}: '${at}.revision' is neither a revision number nor a label.`);
    }
    revision = entry.revision;
  } else if (entry.revision !== undefined && entry.revision !== null) {
    revision = wholeNumber(describe, `${at}.revision`, entry.revision);
  }
  const position =
    entry.position === undefined || entry.position === null
      ? undefined
      : Number(wholeNumber(describe, `${at}.position`, entry.position));
  return {
    layer,
    ...(revision === undefined ? {} : { revision }),
    ...(position === undefined ? {} : { position }),
  };
}

function moved(outcome: BasesMoved): Record<string, unknown> {
  return {
    bases: basesValue(outcome.value.bases),
    merged: outcome.value.merged,
    conflicts: outcome.value.conflicts,
  };
}

function conflicted(describe: string, store: RevisionedGraphStore, what: string): never {
  throw new InvokeError(
    "GRAPH_DRAFT_CONFLICTED",
    `${describe}: ${what} leaves a conflict on layer '${store.layer}', or a relationship the ` +
      `layer states whose endpoint no longer resolves, so nothing was changed. Do it inside ` +
      `a draft session, resolve what it lists there, and publish.`,
  );
}

export const PinBase = baseOperation("PinBase", async (describe, store, inputs, ctx) => {
  if (!Array.isArray(inputs.bases) || inputs.bases.length === 0) {
    throw new Error(`${describe}: 'bases' must name at least one layer.`);
  }
  const requests = inputs.bases.map((entry, index) => pinRequest(describe, entry, index));
  const outcome = await store.pinBases(requests, ctx);
  switch (outcome.status) {
    case "found":
      return moved(outcome);
    case "layerNotFound":
      return layerNotFound(describe, store, outcome.layer);
    case "revisionNotFound":
      throw new InvokeError(
        "GRAPH_REVISION_NOT_FOUND",
        `${describe}: layer '${outcome.layer}' has no revision ` +
          `${typeof outcome.revision === "string" ? `labelled '${outcome.revision}'` : outcome.revision}.`,
        { layer: outcome.layer, revision: outcome.revision },
      );
    case "baseCycle":
      throw new InvokeError(
        "GRAPH_BASE_CYCLE",
        `${describe}: pinning '${outcome.layer}' would put layer '${store.layer}' beneath itself.`,
        { layer: outcome.layer },
      );
    case "baseRevisionConflict":
      return baseRevisionConflict(
        describe,
        outcome,
        "Pin every layer that reaches it in the same call, at revisions that agree.",
      );
    case "baseLimit":
      return baseLimit(describe, outcome);
    case "draftConflicted":
      return conflicted(describe, store, "the move");
  }
});

export const UnpinBase = baseOperation("UnpinBase", async (describe, store, inputs, ctx) => {
  const layer = layerName(describe, "layer", inputs.layer);
  const outcome = await store.unpinBase(layer, ctx);
  switch (outcome.status) {
    case "found":
      return moved(outcome);
    case "baseNotPinned":
      throw new InvokeError(
        "GRAPH_BASE_NOT_PINNED",
        `${describe}: layer '${store.layer}' of store '${declaredName(store)}' is not directly ` +
          `built on '${outcome.layer}'.`,
        { layer: outcome.layer },
      );
    case "draftConflicted":
      return conflicted(describe, store, "removing the pin");
  }
});

export const ListBases = baseOperation("ListBases", async (describe, store, inputs, ctx) => {
  const { value } = await store.listBases(ctx);
  return { bases: basesValue(value) };
});

export const LabelRevision = baseOperation("LabelRevision", async (describe, store, inputs, ctx) => {
  const revision = wholeNumber(describe, "revision", inputs.revision);
  if (!isRevisionLabel(inputs.label)) {
    throw new Error(
      `${describe}: 'label' must be 1 to 128 letters, digits, '.', '_', '+' or '-', at least ` +
        `one of them not a digit.`,
    );
  }
  const outcome = await store.labelRevision(
    { revision, label: inputs.label, actor: actorOf(inputs.actor) },
    ctx,
  );
  switch (outcome.status) {
    case "found":
      return { revision: { number: outcome.value.number, label: outcome.value.label } };
    case "revisionNotFound":
      throw new InvokeError(
        "GRAPH_REVISION_NOT_FOUND",
        `${describe}: layer '${outcome.layer}' has published no revision ${outcome.revision}.`,
        { layer: outcome.layer, revision: outcome.revision },
      );
    case "revisionLabelExists":
      throw new InvokeError(
        "GRAPH_REVISION_LABEL_EXISTS",
        `${describe}: label '${outcome.label}' already names revision ${outcome.revision} of ` +
          `layer '${store.layer}'. A label is never moved.`,
        { label: outcome.label, revision: outcome.revision },
      );
    case "revisionLabelled":
      throw new InvokeError(
        "GRAPH_REVISION_LABELLED",
        `${describe}: revision ${outcome.revision} of layer '${store.layer}' is already ` +
          `labelled '${outcome.label}'. A revision carries one label.`,
        { revision: outcome.revision, label: outcome.label },
      );
  }
});
