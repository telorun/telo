import { DataValidator, RuntimeError } from "@telorun/sdk";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { formatAjvErrors } from "./manifest-schemas.js";

const Ajv = AjvModule.default ?? AjvModule;

export class SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;

  constructor() {
    this.ajv = new Ajv({
      strict: false,
      removeAdditional: false,
      useDefaults: true,
    });
    addFormats.default(this.ajv);
  }

  addSchema(name: string, schema: object): void {
    if (!this.ajv.getSchema(name)) {
      this.ajv.addSchema(schema, name);
    }
  }

  getSchema(name: string): object | undefined {
    return this.ajv.getSchema(name) as object | undefined;
  }

  compile(schema: any): DataValidator {
    const normalized =
      "type" in schema && typeof schema.type === "string"
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
            "ERR_RESOURCE_NOT_FOUND",
            `Invalid value passed: ${JSON.stringify(data)}. Error: ${formatAjvErrors(validate.errors)}`,
          );
        }
      },
      isValid: (data: any) => {
        return validate(data);
      },
    };
  }
}
