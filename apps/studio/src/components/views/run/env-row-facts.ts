import {
  describeSensitiveValueFinding,
  sensitiveValueFindings,
  type SensitiveEnvironmentInput,
  type WorkspaceEnvResolution,
} from "@telorun/analyzer";
import type { WorkspaceAdapter } from "../../../model";
import { workspaceFileOf } from "../../../run/application-env";
import { envValueDestination, writeEnvValue } from "./env-value-write";

/** What the env files say about one env var, and how the row writes it. */
export interface EnvRowFacts {
  value: string | undefined;
  /** The workspace-relative file the value comes from. */
  source: string | undefined;
  /** The run's warning for a sensitive value read from a file not marked so. */
  warning: string | undefined;
  /** Why an unset value has nowhere to be written. */
  unwritable: string | undefined;
  disabled: boolean;
  commit: (next: string) => Promise<void>;
}

/** The facts of every row, over one reading of the env files. A failed or
 *  missing reading leaves every row unset and read-only. */
export function envRowFacts(options: {
  resolution: WorkspaceEnvResolution | null;
  rootDir: string;
  manifestPath: string;
  sensitiveInputs: readonly SensitiveEnvironmentInput[];
  adapter: () => WorkspaceAdapter | null;
  readOnly: boolean;
}): (envVar: string) => EnvRowFacts {
  const { resolution, rootDir, manifestPath, sensitiveInputs, adapter, readOnly } = options;
  const usable = resolution !== null && resolution.failed === undefined ? resolution : null;
  const findings = usable
    ? sensitiveValueFindings(usable, Object.keys(usable.values), sensitiveInputs)
    : [];
  const sensitive = new Set(sensitiveInputs.map((input) => input.env));

  return (envVar) => {
    const value = usable?.values[envVar];
    const source = usable?.sources[envVar];
    const finding = findings.find((candidate) => candidate.input.env === envVar);
    const destination =
      usable && value === undefined
        ? envValueDestination(usable, manifestPath, sensitive.has(envVar))
        : null;
    return {
      value,
      source: source === undefined ? undefined : workspaceFileOf(rootDir, source),
      warning: finding
        ? describeSensitiveValueFinding(finding, workspaceFileOf(rootDir, finding.file))
        : undefined,
      unwritable: destination && "refused" in destination ? destination.refused : undefined,
      disabled: readOnly || usable === null,
      commit: async (next) => {
        const workspace = adapter();
        if (!usable || !workspace) throw new Error("No workspace is open.");
        await writeEnvValue({
          adapter: workspace,
          resolution: usable,
          manifestPath,
          key: envVar,
          value: next,
          sensitive: sensitive.has(envVar),
        });
      },
    };
  };
}
