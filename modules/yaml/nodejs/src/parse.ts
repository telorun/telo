import {
  InvokeError,
  type ControllerContext,
  type ResourceContext,
  type RuntimeResource,
} from "@telorun/sdk";
import { parseAllDocuments } from "yaml";

interface ParseInputs {
  text: string;
}

interface ParseOutputs {
  docs: unknown[];
}

type ParseResource = RuntimeResource;

export function register(_ctx: ControllerContext): void {}

class YamlParse {
  constructor(private readonly resource: ParseResource) {}

  async invoke(inputs: ParseInputs): Promise<ParseOutputs> {
    const name = this.resource.metadata.name;
    if (typeof inputs?.text !== "string") {
      throw new InvokeError(
        "ERR_PARSE_FAILED",
        `Yaml.Parse "${name}": 'text' must be a string.`,
      );
    }

    let parsed;
    try {
      parsed = parseAllDocuments(inputs.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new InvokeError("ERR_PARSE_FAILED", `Yaml.Parse "${name}": ${message}`);
    }

    const docs: unknown[] = [];
    for (const doc of parsed) {
      // parseAllDocuments preserves errors on each Document object — surface
      // them as InvokeErrors so callers see structured failures rather than
      // silently parsing into a partial / null doc.
      if (doc.errors.length > 0) {
        const first = doc.errors[0];
        throw new InvokeError(
          "ERR_PARSE_FAILED",
          `Yaml.Parse "${name}": ${first.message}`,
          { errors: doc.errors.map((e) => ({ message: e.message, code: e.code })) },
        );
      }
      // doc.toJSON() returns null for an empty document (e.g. a `---` with no
      // content). Skip those — they're not meaningful values to surface.
      const value = doc.toJSON();
      if (value === null || value === undefined) continue;
      docs.push(value);
    }

    return { docs };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: ParseResource,
  _ctx: ResourceContext,
): Promise<YamlParse> {
  return new YamlParse(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
