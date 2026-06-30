import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { BufferedResult, ShellHost } from "./shell-host.js";
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
  command: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

function requireCommand(input: CommandInput): string {
  if (typeof input?.command !== "string" || input.command.length === 0) {
    throw new Error("Shell.Command: 'command' input is required and must be a non-empty string");
  }
  return input.command;
}

class ShellCommandResource implements ResourceInstance {
  constructor(
    private readonly manifest: ShellCommandManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: CommandInput, ctx?: InvokeContext): Promise<BufferedResult> {
    const host = resolveShellHost(this.manifest.host, this.ctx);
    const command = requireCommand(input);
    return host
      .exec(command, { env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }, ctx)
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
