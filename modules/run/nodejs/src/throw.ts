import {
  InvokeError,
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface RunThrowManifest {
  metadata: { name: string };
}

interface RunThrowInputs {
  code: string;
  message?: string;
  data?: unknown;
}

class RunThrow implements ResourceInstance<RunThrowInputs, never> {
  async invoke(inputs: RunThrowInputs): Promise<never> {
    if (typeof inputs?.code !== "string" || inputs.code.length === 0) {
      // Deliberate plain Error (not InvokeError): a missing/empty `code` is a
      // manifest bug, not a domain failure. It should surface as InvokeFailed
      // (operational) rather than InvokeRejected (structured) — the kernel's
      // event wrapper routes on isInvokeError to decide which event fires.
      throw new Error(
        "Run.Throw: `code` is required and must be a non-empty string",
      );
    }
    throw new InvokeError(inputs.code, inputs.message ?? inputs.code, inputs.data);
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: RunThrowManifest,
  _ctx: ResourceContext,
): Promise<RunThrow> {
  return new RunThrow();
}
