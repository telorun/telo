import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

type Action =
  | { do: "emit"; field: string }
  | { do: "drop" }
  | { do: "throw"; field: string };

interface ExtractTextResource {
  metadata: { name: string; module?: string };
  discriminator?: string;
  records: Record<string, Action>;
}

interface ExtractTextInputs {
  input: AsyncIterable<unknown>;
}

interface ExtractTextOutputs {
  output: Stream<string>;
}

class ExtractText implements ResourceInstance<ExtractTextInputs, ExtractTextOutputs> {
  private readonly discriminator: string;
  private readonly records: Record<string, Action>;

  constructor(private readonly resource: ExtractTextResource) {
    this.discriminator = resource.discriminator ?? "type";
    this.records = resource.records;
    validateRecordsConfig(this.resource.metadata.name, this.records);
  }

  async invoke(inputs: ExtractTextInputs): Promise<ExtractTextOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `RecordStream.ExtractText "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(project(input, name, this.discriminator, this.records)) };
  }

  snapshot(): Record<string, unknown> {
    return { discriminator: this.discriminator, records: this.records };
  }
}

function validateRecordsConfig(name: string, records: Record<string, Action>): void {
  for (const [tag, action] of Object.entries(records)) {
    if (action.do === "emit" || action.do === "throw") {
      if (typeof (action as { field?: unknown }).field !== "string") {
        throw new InvokeError(
          "ERR_INVALID_CONFIG",
          `RecordStream.ExtractText "${name}": records[${JSON.stringify(tag)}] action "${action.do}" requires \`field\`.`,
        );
      }
    }
  }
}

async function* project(
  input: AsyncIterable<unknown>,
  name: string,
  discriminator: string,
  records: Record<string, Action>,
): AsyncIterable<string> {
  for await (const item of input) {
    if (!item || typeof item !== "object") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `RecordStream.ExtractText "${name}": items must be objects; got ${typeof item}.`,
      );
    }
    const tag = (item as Record<string, unknown>)[discriminator];
    if (typeof tag !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `RecordStream.ExtractText "${name}": record is missing string discriminator field "${discriminator}".`,
      );
    }
    const action = records[tag];
    if (!action) {
      throw new InvokeError(
        "ERR_UNKNOWN_RECORD",
        `RecordStream.ExtractText "${name}": no entry in \`records\` for ${discriminator}=${JSON.stringify(tag)}.`,
      );
    }
    if (action.do === "drop") continue;
    const value = (item as Record<string, unknown>)[action.field];
    if (action.do === "emit") {
      if (typeof value !== "string") {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `RecordStream.ExtractText "${name}": record ${discriminator}=${JSON.stringify(tag)} field "${action.field}" must be a string; got ${typeof value}.`,
        );
      }
      yield value;
      continue;
    }
    // action.do === "throw"
    const message =
      value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
        ? (value as { message: string }).message
        : String(value);
    throw new Error(message);
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: ExtractTextResource,
  _ctx: ResourceContext,
): Promise<ExtractText> {
  return new ExtractText(resource);
}
