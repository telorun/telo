export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  oneOf?: Array<{ type?: string; properties?: Record<string, JsonSchemaProperty>; [key: string]: unknown }>;
  anyOf?: Array<{ type?: string; properties?: Record<string, JsonSchemaProperty>; [key: string]: unknown }>;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
};

export type JsonSchema = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export interface ResolvedResourceOption {
  kind: string;
  name: string;
  capability?: string;
}
