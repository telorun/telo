import type { AcceptedQuery, CollectionIdentity } from "./collection-source.js";
import type { AssetFile, SpecNode } from "./composite.js";
import type { JsonSchema } from "./model-schema.js";
import type { OptionSourceSpec } from "./option-source.js";

/** The collection a listing reads, as its layout sees it: its record shape,
 *  key and accepted query, which declaration it is, and the target of each
 *  relation it declares — either unknown where it cannot be followed. */
export interface LayoutCollection {
  model: JsonSchema;
  key: string;
  query: AcceptedQuery;
  identity?: CollectionIdentity;
  relations: Record<string, { target?: CollectionIdentity }>;
}

/** What a listing hands its layout: its row model, its collection and the
 *  related records it labels. */
export interface LayoutInputs {
  model: JsonSchema;
  collection: LayoutCollection;
  relations: Record<string, OptionSourceSpec>;
}

export interface LayoutProblem {
  code: string;
  message: string;
}

/** A `Ui.ListingLayoutAnswer`: `spec` exactly when `problems` is empty. */
export interface LayoutAnswer {
  problems: LayoutProblem[];
  spec?: SpecNode;
  assets: AssetFile[];
}

export interface LayoutInstance {
  invoke(inputs: LayoutInputs): Promise<LayoutAnswer>;
}

export function isLayout(candidate: unknown): candidate is LayoutInstance {
  return typeof (candidate as LayoutInstance | null)?.invoke === "function";
}
