import { InvokeError, type ResourceInstance } from "@telorun/sdk";
import { mintKey, PREFIX_PATTERN } from "./key-format.js";

/** ApiKey.Generate — mint a key and its declared-key entry fields without a store. */
class Generate implements ResourceInstance<{ prefix: string }, { key: string; id: string; digest: string }> {
  async invoke(inputs: { prefix: string }): Promise<{ key: string; id: string; digest: string }> {
    if (!PREFIX_PATTERN.test(inputs.prefix)) {
      throw new InvokeError("ERR_INPUT_INVALID", `ApiKey.Generate: 'prefix' must match ${PREFIX_PATTERN}.`);
    }
    const { key, id, digest } = mintKey(inputs.prefix);
    return { key, id, digest };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(): Promise<Generate> {
  return new Generate();
}

export function register(): void {}
