/**
 * `telo-workspace.yaml` as a Telo host reads it — the `release:` block, read by
 * `@telorun/release` against the ecosystems the host serves, and the `env:`
 * block `telo run` reads.
 *
 * **Its location is the anchor, and every field lives in a block scoped to what
 * it governs.** The file and every block in it are optional; a marker whose
 * whole content is comments anchors the cache and bounds the env walk, which is
 * what a runner seeds one for.
 *
 * **The reader is lenient; the diagnostics are the strict half.** Which are
 * fatal is the CALLER's policy: `telo release` refuses on any error, while `telo
 * run` consumes `env:` alone and prints the rest. Gitignore matching is
 * INJECTED (`PatternMatch`), because the grammar is the glob package's.
 */

import {
  AdapterRegistry,
  WORKSPACE_FILENAME,
  nearMiss,
  parseMarker,
  readReleaseBlock,
  readSchemaBlock,
  type EcosystemAdapter,
  type MarkerReport,
  type ReadEntry,
  type ReleaseSettings,
  type WorkspaceDiagnostic,
} from "@telorun/release";
import { TELO_RELEASE_ADAPTERS } from "./telo-adapter.js";
import {
  DEFAULT_ENV_FILES,
  ENV_BLOCK_SCHEMA,
  WORKSPACE_BLOCKS,
  type EnvFileEntry,
} from "./workspace-schema.js";

export { DEFAULT_ENV_FILES, WORKSPACE_FILENAME };
export type { EnvFileEntry };

export interface EnvSettings {
  readonly roots?: readonly string[];
  readonly files?: readonly EnvFileEntry[];
}

export interface WorkspaceConfig {
  readonly release?: ReleaseSettings;
  readonly env?: EnvSettings;
}

export interface WorkspaceRead {
  readonly config: WorkspaceConfig;
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}

/**
 * Read the marker's text, the `release:` block against `adapters` (the
 * ecosystems a Telo host serves by default). Never throws: unreadable YAML is
 * itself a diagnostic, because the run path must not abort on it.
 */
export function readWorkspaceConfig(
  text: string,
  where: string,
  adapters: readonly EcosystemAdapter[] = TELO_RELEASE_ADAPTERS,
): WorkspaceRead {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const report: MarkerReport = (code, message, path, severity = "error") => {
    diagnostics.push({ code, severity, message, path });
  };

  const record = parseMarker(text, where, report);
  if (!record) return { config: {}, diagnostics };

  for (const key of Object.keys(record)) {
    if (WORKSPACE_BLOCKS.includes(key)) continue;
    if (key === "modules") {
      report(
        "WORKSPACE_MODULES_MOVED",
        `${where}: 'modules' is no top-level key. The release units are listed under ` +
          `'release.units', each with the ecosystem it ships through, e.g. ` +
          `{ path: modules/*, ecosystem: telo }.`,
        ["modules"],
      );
      continue;
    }
    // A near-miss of a block name is a typo whose settings would go silently
    // unapplied; an unrecognized block is a version skew, so the next one ships
    // without breaking today's runs.
    const near = nearMiss(key, WORKSPACE_BLOCKS);
    if (near) {
      report("WORKSPACE_UNKNOWN_KEY", `${where}: unknown block '${key}'. Did you mean '${near}'?`, [key]);
    } else {
      report(
        "WORKSPACE_UNKNOWN_KEY",
        `${where}: unknown block '${key}', which nothing reads. This telo knows ${WORKSPACE_BLOCKS.map((b) => `'${b}'`).join(" and ")}.`,
        [key],
        "warning",
      );
    }
  }

  const release = readReleaseBlock(record.release, where, report, new AdapterRegistry(adapters));
  const env = readEnv(record.env, where, report);
  return {
    config: { ...(release ? { release } : {}), ...(env ? { env } : {}) },
    diagnostics,
  };
}

function readEnv(raw: unknown, where: string, report: MarkerReport): EnvSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: 'env' must be a mapping.`, ["env"]);
    return undefined;
  }
  const read = readSchemaBlock(raw as Record<string, unknown>, ENV_BLOCK_SCHEMA.properties, where, ["env"], report);
  const roots = read.roots as readonly string[] | undefined;
  const entries = read.files as readonly ReadEntry[] | undefined;
  for (const { index, bare, fields } of entries ?? []) {
    // A path would let one entry reach outside the bound `roots:` exists to
    // state, so the list is filenames and the refusal is structural.
    const name = fields.name as string;
    if (name.includes("/") || name.includes("\\") || name.includes("*")) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: 'env.files' entry '${name}' is a path or a glob. It names a file collected in ` +
          `each directory the walk visits, so it must be a bare filename — the walk's reach is ` +
          `'env.roots'.`,
        bare ? ["env", "files", index] : ["env", "files", index, "name"],
      );
    }
  }
  const files = entries?.map(({ fields }) => ({
    name: fields.name as string,
    sensitive: fields.sensitive === true,
  }));
  return {
    ...(roots !== undefined ? { roots } : {}),
    ...(files !== undefined ? { files } : {}),
  };
}

/**
 * Gitignore-style matching over one authored list: the index of the LAST
 * pattern matching `path`, or `-1` — which makes a decision attributable to the
 * entry that made it.
 */
export type PatternMatch = (path: string, patterns: readonly string[]) => number;

/** Whether `path` is matched by an authored pattern list, negations honoured.
 *  `env.roots` and a resolved `ignore` list are both read through this. */
export function matchesPatterns(
  path: string,
  patterns: readonly string[],
  match: PatternMatch,
): boolean {
  const index = match(path, patterns);
  return index >= 0 && !patterns[index]!.startsWith("!");
}
