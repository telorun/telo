import type { ResourceInstance, RuntimeResource, TextRecord } from "@telorun/sdk";

/** The words a renderer shows of its own, by id, each the record of the text
 *  the module declaring the resource wrote. */
export type Words = Readonly<Record<string, TextRecord>>;

export interface WordsInstance extends ResourceInstance {
  provide(): Promise<Words>;
}

export function isWords(candidate: unknown): candidate is WordsInstance {
  return typeof (candidate as WordsInstance | null)?.provide === "function";
}

/** `Ui.Words`: the configuration, every word received as its record. */
export function create(resource: RuntimeResource & Record<string, unknown>): WordsInstance {
  const { kind, metadata, ...words } = resource;
  return { provide: async () => words as unknown as Words };
}
