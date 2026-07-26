import {
  Stream,
  type KindRef,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { ShellHost, StreamPart } from "./shell-host.js";
import { isShellHost, toCommandSpec } from "./shell-host.js";

interface ShellCommandStreamManifest {
  metadata: { name: string; module: string };
  host?: ShellHost | KindRef<ShellHost>;
}

interface CommandInput {
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  stdin?: string;
  timeoutMs?: number;
}

class ShellCommandStreamResource implements ResourceInstance {
  constructor(
    private readonly manifest: ShellCommandStreamManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: CommandInput, ctx?: InvokeContext): Promise<{ output: Stream<StreamPart> }> {
    const host = this.ctx.resolveRef(
      this.manifest.host,
      isShellHost,
      () => `Shell.CommandStream "${this.manifest.metadata.name}": 'host'`,
      "std/shell#Host",
    );
    const spec = toCommandSpec(input, "Shell.CommandStream");
    const iterable = host
      .exec(spec, { env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }, ctx)
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
