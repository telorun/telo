/**
 * The workspace's env files: the walk a run reads them through, the format they
 * are written in, and which of them are sensitive. Browser-safe — every file is
 * reached through the one read its host injects — so the CLI, a packaged
 * application and Studio resolve, write and classify them identically.
 */

export {
  appendEnvFileLines,
  appendEnvFileValue,
  clearEnvFileValue,
  parseEnvFile,
  setEnvFileValue,
  spellEnvFileValue,
} from "./env-file-format.js";
export type { EnvFileAssignment, EnvFileEdit, EnvFileSpan } from "./env-file-format.js";

export { resolveWorkspaceEnv } from "./env-file-resolution.js";
export type {
  EnvFileContribution,
  EnvFileRead,
  ReadEnvFile,
  ResolveWorkspaceEnvOptions,
  UnreadableEnvFile,
  WorkspaceEnvResolution,
} from "./env-file-resolution.js";

export {
  classifySensitiveEnvFiles,
  describeSensitiveValueFinding,
  envFileDestination,
  sensitiveValueFindings,
} from "./env-file-sensitivity.js";
export type { SensitiveEnvFiles, SensitiveValueFinding } from "./env-file-sensitivity.js";

export { workspacePathJoin, workspacePathParent, workspacePathRelative } from "./workspace-path.js";
