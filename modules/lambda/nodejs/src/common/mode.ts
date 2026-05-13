/**
 * Lambda deployment mode is inferred from the runtime environment, never from
 * the manifest. AWS sets `$AWS_LAMBDA_RUNTIME_API` only in custom runtimes
 * (provided.al2023 or container images). Managed runtimes (nodejs24.x) leave it
 * unset and the bootstrap-exported `handler` is called by AWS directly.
 */
export type LambdaMode = "managed" | "custom";

export function detectMode(env: NodeJS.ProcessEnv = process.env): LambdaMode {
  return env.AWS_LAMBDA_RUNTIME_API ? "custom" : "managed";
}
