import { evaluate } from "@marcbachmann/cel-js";
import { DataValidator, RuntimeError, TypeRule } from "@telorun/sdk";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { formatAjvErrors } from "./manifest-schemas.js";

const Ajv = AjvModule.default ?? AjvModule;

export class SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;
  private typeRules = new Map<string, TypeRule[]>();
  private rawSchemas = new Map<string, object>();

  constructor() {
    this.ajv = new Ajv({
      strict: false,
      removeAdditional: false,
      useDefaults: true,
    });
    addFormats.default(this.ajv);
    for (const kw of [
      "x-telo-ref",
      "x-telo-eval",
      "x-telo-scope",
      "x-telo-context",
      "x-telo-context-from",
      "x-telo-context-ref-from",
      "x-telo-schema-from",
      "x-telo-topology-role",
      "x-telo-step-context",
    ]) {
      this.ajv.addKeyword(kw);
    }
  }

  addSchema(name: string, schema: object): void {
    if (!this.ajv.getSchema(name)) {
      this.ajv.addSchema(schema, name);
    }
    this.rawSchemas.set(name, schema);
  }

  getSchema(name: string): object | undefined {
    return this.rawSchemas.get(name);
  }

  addTypeRules(name: string, rules: TypeRule[]): void {
    this.typeRules.set(name, rules);
  }

  getTypeRules(name: string): TypeRule[] | undefined {
    return this.typeRules.get(name);
  }

  compile(schema: any): DataValidator {
    const isFullSchema =
      ("type" in schema && typeof schema.type === "string") ||
      "allOf" in schema ||
      "anyOf" in schema ||
      "oneOf" in schema ||
      "$ref" in schema;
    const normalized = isFullSchema
      ? schema
      : {
          type: "object",
          properties: schema,
          required: Object.keys(schema),
          additionalProperties: false,
        };
    const injected =
      normalized.additionalProperties === false
        ? {
            ...normalized,
            properties: {
              kind: { type: "string" },
              metadata: { type: "object" },
              ...normalized.properties,
            },
          }
        : normalized;
    const validate = this.ajv.compile(injected);

    return {
      validate: (data: any) => {
        const isValid = validate(data);
        if (!isValid) {
          throw new RuntimeError(
            "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
            `Invalid value passed: ${JSON.stringify(data)}. Error: ${formatAjvErrors(validate.errors)}`,
          );
        }
      },
      isValid: (data: any) => {
        return validate(data);
      },
    };
  }

  composeWithRules(base: DataValidator, typeName: string, rules: TypeRule[]): DataValidator {
    return {
      validate: (data: any) => {
        base.validate(data);
        for (const rule of rules) {
          let result: unknown;
          try {
            result = evaluate(rule.condition, { this: data });
          } catch (err) {
            throw new RuntimeError(
              "ERR_TYPE_VALIDATION_FAILED",
              `Type "${typeName}" rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (result !== true) {
            throw new RuntimeError(
              rule.code ?? "ERR_TYPE_VALIDATION_FAILED",
              rule.message ?? `Type "${typeName}" validation failed: rule "${rule.code}" not satisfied`,
            );
          }
        }
      },
      isValid: (data: any) => {
        if (!base.isValid(data)) return false;
        for (const rule of rules) {
          try {
            if (evaluate(rule.condition, { this: data }) !== true) return false;
          } catch {
            return false;
          }
        }
        return true;
      },
    };
  }
}
