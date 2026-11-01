export type JsonSchema = Record<string, any>;

/** What a collection declares its list endpoint accepts. */
export interface AcceptedQuery {
  filters: { property: string; operator: string }[];
  sort: { property: string }[];
  facets: { property: string }[];
}

/** What a relation's guards read of the collection it points at. */
export interface RelationTarget {
  model: JsonSchema;
  key: string;
  query: Pick<AcceptedQuery, "filters">;
}
