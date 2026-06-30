import { Stream, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import type { ShellHost, StreamPart } from "./shell-host.js";
import { resolveShellHost } from "./shell-host-ref.js";

interface HostRef {
  name: string;
  alias?: string;
}

interface ShellCommandStreamManifest {
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
    throw new Error("Shell.CommandStream: 'command' input is required and must be a non-empty string");
  }
  return input.command;
}

class ShellCommandStreamResource implements ResourceInstance {
  constructor(
    private readonly manifest: ShellCommandStreamManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: CommandInput, ctx?: InvokeContext): Promise<{ output: Stream<StreamPart> }> {
    const host = resolveShellHost(this.manifest.host, this.ctx);
    const command = requireCommand(input);
    const iterable = host
      .exec(command, { env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }, ctx)
      .stream();
    return { output: new Stream(iterable) };
  }
}

export function register(): void {}

export async function create(
  resource: ShellCommandStreamManifest,
  ctx: ResourceContext,
): Promise<ShellCommandStreamResource> {
  return new ShellCommandStreamResource(resource, ctx);
}
