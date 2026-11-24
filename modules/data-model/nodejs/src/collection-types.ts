export type JsonSchema = Record<string, any>;

/** What a collection declares its list endpoint accepts. */
export interface AcceptedQuery {
  filters: { property: string; operator: string }[];
  sort: { property: string }[];
  facets: { property: string }[];
  /** Absent: a request carries no `search`. */
  search?: { properties: string[] };
}

/** What a relation's guards read of the collection it points at. */
export interface RelationTarget {
  model: JsonSchema;
  key: string;
  query: Pick<AcceptedQuery, "filters">;
}

/** The body each write accepts; one left out is a write the collection does not take. */
export interface DeclaredSchemas {
  create?: JsonSchema;
  update?: JsonSchema;
}
