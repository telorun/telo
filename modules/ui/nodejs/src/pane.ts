import type { InvokeContext } from "@telorun/sdk";
import type { AssetFile, SpecNode } from "./composite.js";

/** The request a pane is drawn for. */
export interface PaneRequest {
  headers: Record<string, string>;
  ip?: string;
  lang?: string;
}

/** What a pane is invoked with: the request where its tree is delivered per
 *  request, nothing where it is resolved once, at creation. */
export interface PaneInputs {
  request?: PaneRequest;
}

/** What a pane answers: the node drawn in its place, or nothing. */
export interface PaneAnswer {
  node?: SpecNode;
}

/** What a pane, a page or a layout publishes: every file the nodes it answers
 *  can name, known at creation. Absent, it names no file. */
export interface AssetsReading {
  assets?: AssetFile[];
}

/** A `Ui.Pane`, as whoever places it holds it. */
export interface PaneInstance {
  invoke(inputs: PaneInputs, context?: InvokeContext): Promise<PaneAnswer>;
  snapshot?(): AssetsReading;
}

export const isPane = (candidate: unknown): candidate is PaneInstance =>
  typeof (candidate as PaneInstance | null)?.invoke === "function";

/** The files a pane's reading names. */
export const paneAssets = (pane: PaneInstance): AssetFile[] => pane.snapshot?.()?.assets ?? [];

/** What a pane is invoked with for `request`, none where it is resolved at creation. */
export const paneInputs = (request: PaneRequest | null): PaneInputs => (request === null ? {} : { request });

/** Each pane's answer at creation, kept: a pane inside a composite is resolved
 *  once, however many times the composites holding it are read. */
const answeredAtCreation = new WeakMap<PaneInstance, Promise<PaneAnswer>>();

/** What a pane answers where it is resolved at creation, with no request. */
export function answerAtCreation(pane: PaneInstance): Promise<PaneAnswer> {
  let answer = answeredAtCreation.get(pane);
  if (answer === undefined) {
    answer = pane.invoke({});
    answeredAtCreation.set(pane, answer);
  }
  return answer;
}
