/**
 * Which environment variables an application reads are SENSITIVE: a root
 * `secrets:` entry bound by `env:`, and a need field the need table marks
 * sensitive. One reader, so where `telo env template` and Studio write a value,
 * and whether a run warns about the file it came from, are the same answer.
 *
 * Browser-safe. The need half is the table's `environment` list — the needs read
 * from the environment at load, each field carrying its variable and its mark —
 * so a need the table does not read from the environment contributes nothing.
 */

import type { NeedEnvironmentEntry } from "./need-table.js";

export interface SensitiveEnvironmentInput {
  /** The environment variable. */
  readonly env: string;
  /** What reads it, as a reader would say it. */
  readonly source: "secret" | "sensitive need field";
  /** The `secrets:` key, or the need path and field (`databaseAccess.url`). */
  readonly name: string;
}

/** The sensitive inputs of the root Application `root`, in declaration order;
 *  none for any other document. */
export function sensitiveEnvironmentInputs(
  root: unknown,
  needEnvironment: readonly NeedEnvironmentEntry[],
): SensitiveEnvironmentInput[] {
  const doc = root as { kind?: unknown; secrets?: unknown } | null | undefined;
  if (!doc || typeof doc !== "object" || doc.kind !== "Telo.Application") return [];
  const secrets = doc.secrets && typeof doc.secrets === "object" && !Array.isArray(doc.secrets) ? doc.secrets : {};
  const inputs: SensitiveEnvironmentInput[] = [];
  for (const [name, entry] of Object.entries(secrets as Record<string, unknown>)) {
    const env = (entry as { env?: unknown } | null)?.env;
    if (typeof env === "string" && env !== "") inputs.push({ env, source: "secret", name });
  }
  for (const entry of needEnvironment) {
    for (const [field, info] of Object.entries(entry.fields ?? {})) {
      if (info.sensitive) inputs.push({ env: info.env, source: "sensitive need field", name: `${entry.path.join(".")}.${field}` });
    }
  }
  return inputs;
}
