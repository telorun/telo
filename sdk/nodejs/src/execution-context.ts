import { EvaluationContext } from "./evaluation-context.js";
import { ModuleContext } from "./module-context.js";

/**
 * The ephemeral, per-trigger context layer. Merges a ModuleContext with
 * arbitrary execution-time properties (e.g. { request, inputs } for HTTP;
 * any shape is valid — determined by the trigger type).
 *
 * Execution props overlay the module namespaces on key conflict.
 */
export class ExecutionContext extends EvaluationContext {
  constructor(moduleCtx: ModuleContext, execProps: Record<string, unknown>) {
    super(
      moduleCtx.source,
      Object.assign(Object.create(null), moduleCtx.context, execProps) as Record<string, unknown>,
      moduleCtx.createInstance,
      moduleCtx.secretValues,
      moduleCtx.emit,
    );
  }
}
