import type { RunAdapter } from "./types";

const adapters = new Map<string, RunAdapter<unknown>>();

export const registry = {
  register<Config>(adapter: RunAdapter<Config>): void {
    if (adapters.has(adapter.id)) {
      throw new Error(`Run adapter already registered: ${adapter.id}`);
    }
    adapters.set(adapter.id, adapter as RunAdapter<unknown>);
  },

  list(): RunAdapter<unknown>[] {
    return Array.from(adapters.values());
  },

  get(id: string): RunAdapter<unknown> | undefined {
    return adapters.get(id);
  },

  clear(): void {
    adapters.clear();
  },
};
