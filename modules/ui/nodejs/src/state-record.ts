import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import type { JsonSchema } from "./model-schema.js";
import { isStateStore, memoryStore, type StateStoreSpec } from "./state-store.js";

/** A `Ui.StateRecord` as written. A member holding nothing is one left out. */
export interface StateConfig {
  key: string;
  address?: boolean | null;
  store?: unknown;
  fields?: string[] | null;
}

/** Where kept values live, as a renderer receives it. */
export interface StateSpec {
  key?: string;
  address: boolean;
  store: StateStoreSpec;
  fields: string[];
}

/**
 * The state record a renderer receives: the properties kept — the ones
 * listed, which must be shown, or every one shown — never one the model marks
 * `writeOnly`, the address, and the store (`memory` when none is named).
 * `at` names the record's place in the owner.
 */
export async function stateSpec(
  state: StateConfig | undefined | null,
  shown: string[],
  schema: JsonSchema,
  ctx: ResourceContext,
  owner: string,
  at: string,
  shows: string,
): Promise<StateSpec> {
  const listed = state?.fields ?? undefined;
  listed?.forEach((property, index) => {
    if (!shown.includes(property)) {
      throw new RuntimeError(
        "ERR_UI_STATE_FIELD_UNKNOWN",
        `${owner}: '${at}.fields[${index}]' keeps a property no ${shows} shows ('${property}'). Name only properties the ${shows}s enter, or leave '${at}.fields' out to keep every one.`,
      );
    }
  });
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const fields = (listed ?? shown).filter((property) => properties[property]?.writeOnly !== true);
  const store =
    state?.store == null
      ? memoryStore()
      : await ctx.resolveRef(state.store, isStateStore, () => `'${at}.store' of ${owner}`, "Ui.StateStore").provide();
  return {
    ...(state != null ? { key: state.key } : {}),
    address: state?.address ?? false,
    store,
    fields: [...new Set(fields)],
  };
}
