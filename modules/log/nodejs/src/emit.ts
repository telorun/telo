import type {
  LevelName,
  LogAttributes,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { severityForLevel } from "@telorun/sdk";

interface EmitInputs {
  level: LevelName;
  message: string;
  attributes?: LogAttributes;
}

/**
 * One record per call, through the resource's own logger: the kernel attaches
 * the resource identity, its import scope and the active span's trace ids, and
 * applies the scope's threshold, redaction and every attached sink. The input
 * contract (level name, closed shape) is bound by the kernel before `invoke`.
 */
class LogEmit implements ResourceInstance<EmitInputs, Record<string, never>> {
  constructor(private readonly ctx: ResourceContext) {}

  async invoke(inputs: EmitInputs): Promise<Record<string, never>> {
    this.ctx.log.log(severityForLevel(inputs.level), inputs.message, inputs.attributes);
    return {};
  }
}

export async function create(resource: unknown, ctx: ResourceContext): Promise<LogEmit> {
  return new LogEmit(ctx);
}
