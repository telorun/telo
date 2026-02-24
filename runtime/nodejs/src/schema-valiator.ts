import { DataValidator } from "@telorun/sdk";
import AjvModule from "ajv";
import { formatAjvErrors } from "./manifest-schemas.js";
import { RuntimeError } from "./types.js";
const Ajv = AjvModule.default ?? AjvModule;

export class SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;

  constructor() {
    this.ajv = new Ajv({
      strict: false,
      removeAdditional: false,
      useDefaults: true,
    });
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
    const validate = this.ajv.compile(
      "type" in schema && typeof schema.type === "string"
        ? schema
        : {
            type: "object",
            properties: schema,
            required: Object.keys(schema),
            additionalProperties: false,
          },
    );

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
