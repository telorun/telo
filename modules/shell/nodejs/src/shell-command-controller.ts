import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { BufferedResult, ShellHost } from "./shell-host.js";
import { toCommandSpec } from "./shell-host.js";
import { resolveShellHost } from "./shell-host-ref.js";

interface HostRef {
  name: string;
  alias?: string;
}

interface ShellCommandManifest {
  metadata: { name: string; module: string };
  host?: ShellHost | HostRef;
}

interface CommandInput {
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  stdin?: string;
  timeoutMs?: number;
}

class ShellCommandResource implements ResourceInstance {
  constructor(
    private readonly manifest: ShellCommandManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: CommandInput, ctx?: InvokeContext): Promise<BufferedResult> {
    const host = resolveShellHost(this.manifest.host, this.ctx);
    const spec = toCommandSpec(input, "Shell.Command");
    return host
      .exec(spec, { env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }, ctx)
      .buffered();
  }
}

export function register(): void {}

export async function create(
  resource: ShellCommandManifest,
  ctx: ResourceContext,
): Promise<ShellCommandResource> {
  return new ShellCommandResource(resource, ctx);
}
