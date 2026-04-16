import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";

type EntryType = "string" | "integer" | "number" | "boolean";

type EntryDef = {
  env: string;
  type: EntryType;
  default?: unknown;
  [key: string]: unknown;
};

type EnvResource = RuntimeResource & {
  variables?: Record<string, EntryDef>;
  secrets?: Record<string, EntryDef>;
};

class ConfigEnv implements ResourceInstance {
  private _values: Record<string, unknown> = {};

  constructor(
    private readonly resource: EnvResource,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {
    const errors: string[] = [];

    const variableEntries = Object.entries(this.resource.variables ?? {}).map(
      ([k, v]) => [k, v, false] as const,
    );
    const secretEntries = Object.entries(this.resource.secrets ?? {}).map(
      ([k, v]) => [k, v, true] as const,
    );

    for (const [name, entry] of [...variableEntries, ...secretEntries]) {
      const envKey = entry.env;
      const raw = this.ctx.env[envKey];

      if (raw === null || raw === undefined) {
        if (entry.default !== undefined) {
          const schema = buildValidationSchema(entry);
          try {
            this.ctx.validateSchema(entry.default, schema);
            this._values[name] = entry.default;
          } catch (e) {
            errors.push(`${name}: ${formatValidationError(e)}`);
          }
          continue;
        }
        errors.push(`${name}: environment variable ${envKey} is not set (no default)`);
        continue;
      }

      let coerced: unknown;
      try {
        coerced = coerce(raw, entry.type);
      } catch (e) {
        errors.push(`${name}: environment variable ${envKey}: ${(e as Error).message}`);
        continue;
      }

      const schema = buildValidationSchema(entry);
      try {
        this.ctx.validateSchema(coerced, schema);
      } catch (e) {
        errors.push(`${name}: ${formatValidationError(e)}`);
        continue;
      }

      this._values[name] = coerced;
    }

    if (errors.length > 0) {
      throw new RuntimeError(
        "ERR_FATAL",
        `Config.Env "${this.resource.metadata.name}" failed:\n` +
          errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return { ...this._values };
  }
}

function buildValidationSchema(entry: EntryDef): object {
  const skip = new Set(["env", "default"]);
  const schema: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!skip.has(k)) {
      schema[k] = v;
    }
  }
  return schema;
}

function coerce(value: string, type: EntryType): unknown {
  switch (type) {
    case "string":
      return value;
    case "integer": {
      if (!/^-?\d+$/.test(value.trim())) {
        throw new Error(`value "${value}" is not a valid integer`);
      }
      return parseInt(value.trim(), 10);
    }
    case "number": {
      const n = parseFloat(value);
      if (isNaN(n)) {
        throw new Error(`value "${value}" is not a valid number`);
      }
      return n;
    }
    case "boolean":
      return value === "true";
  }
}

function formatValidationError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^\[.*?\]\s+Invalid value\.\s+Error:\s+/, "");
}

export function create(resource: EnvResource, ctx: ResourceContext): ResourceInstance {
  return new ConfigEnv(resource, ctx);
}
