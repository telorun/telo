import type { JSONSchema7 } from "json-schema";
import type { ComponentType } from "react";

export interface RunAdapter<Config = unknown> {
  id: string;
  displayName: string;
  description: string;

  configSchema: JSONSchema7;
  defaultConfig: Config;

  validateConfig(config: Config): ConfigIssue[];

  customForm?: ComponentType<{
    value: Config;
    issues: ConfigIssue[];
    onChange: (next: Config) => void;
  }>;

  isAvailable(config: Config): Promise<AvailabilityReport>;

  start(request: RunRequest, config: Config): Promise<RunSession>;
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }
  | { status: "unavailable"; message: string; remediation?: string };

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface RunRequest {
  bundle: RunBundle;
  env?: Record<string, string>;
}

export interface RunBundle {
  entryRelativePath: string;
  files: Array<{ relativePath: string; contents: string }>;
}

export interface RunSession {
  id: string;
  getStatus(): RunStatus;
  subscribe(listener: (event: RunEvent) => void): () => void;
  stop(): Promise<void>;
}

export type RunStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export type RunEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus };

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}
