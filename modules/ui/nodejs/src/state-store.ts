import type { ResourceInstance } from "@telorun/sdk";

/** Where a piece of interface keeps its state, as a renderer receives it. */
export interface StateStoreSpec {
  type: "memory" | "local" | "session";
}

export interface StateStoreInstance {
  provide(): Promise<StateStoreSpec>;
}

export function isStateStore(candidate: unknown): candidate is StateStoreInstance {
  return typeof (candidate as StateStoreInstance | null)?.provide === "function";
}

/** What a bar that names no store carries. */
export const memoryStore = (): StateStoreSpec => ({ type: "memory" });

const store = (type: StateStoreSpec["type"]) => ({
  async create(): Promise<ResourceInstance> {
    return { provide: async (): Promise<StateStoreSpec> => ({ type }) };
  },
});

export const LocalStoreController = store("local");
export const SessionStoreController = store("session");
