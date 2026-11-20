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
  reportUnknownKeys,
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

/** One accepted advisory: `index` is its place in `audit.ignore`. */
export interface AuditIgnoreEntry {
  readonly index: number;
  readonly id: string;
  readonly reason: string;
  /** `YYYY-MM-DD`, the last day the acceptance holds. */
  readonly expires: string;
}

export interface AuditSettings {
  readonly ignore: readonly AuditIgnoreEntry[];
}

export interface WorkspaceConfig {
  readonly release?: ReleaseSettings;
  readonly env?: EnvSettings;
  readonly audit?: AuditSettings;
}

/** A marker diagnostic; `data.nearMiss` names the block an unknown key is a near-miss of. */
export interface TeloWorkspaceDiagnostic extends WorkspaceDiagnostic {
  readonly data?: { readonly nearMiss?: string };
}

export interface WorkspaceRead {
  readonly config: WorkspaceConfig;
  readonly diagnostics: readonly TeloWorkspaceDiagnostic[];
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
  const diagnostics: TeloWorkspaceDiagnostic[] = [];
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
    const near = blockNearMiss(key);
    if (near) {
      diagnostics.push({
        code: "WORKSPACE_UNKNOWN_KEY",
        severity: "error",
        message: `${where}: unknown block '${key}'. Did you mean '${near}'?`,
        path: [key],
        data: { nearMiss: near },
      });
    } else {
      report(
        "WORKSPACE_UNKNOWN_KEY",
        `${where}: unknown block '${key}', which nothing reads. This telo knows ${WORKSPACE_BLOCKS.map((b) => `'${b}'`).join(", ")}.`,
        [key],
        "warning",
      );
    }
  }

  const release = readReleaseBlock(record.release, where, report, new AdapterRegistry(adapters));
  const env = readEnv(record.env, where, report);
  const audit = readAudit(record.audit, report);
  return {
    config: {
      ...(release ? { release } : {}),
      ...(env ? { env } : {}),
      ...(audit ? { audit } : {}),
    },
    diagnostics,
  };
}

/** `nearMiss`, plus two adjacent letters swapped (`audti`), which is the commonest typo of a block name. */
function blockNearMiss(key: string): string | undefined {
  const near = nearMiss(key, WORKSPACE_BLOCKS);
  if (near) return near;
  const lower = key.toLowerCase();
  return WORKSPACE_BLOCKS.find((block) => {
    if (block.length !== lower.length) return false;
    for (let i = 0; i + 1 < block.length; i++) {
      if (block[i] === lower[i + 1] && block[i + 1] === lower[i] && block.slice(i + 2) === lower.slice(i + 2) && block.slice(0, i) === lower.slice(0, i)) return true;
    }
    return false;
  });
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

const AUDIT_IGNORE_KEYS = ["id", "reason", "expires"] as const;

function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** The `audit:` block. Every entry needs all three keys, so a bare string or a
 *  missing `reason` is an error rather than an acceptance nobody explained. */
function readAudit(raw: unknown, report: MarkerReport): AuditSettings | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", "audit must be a mapping holding 'ignore:'.", ["audit"]);
    return undefined;
  }
  const block = raw as Record<string, unknown>;
  reportUnknownKeys(block, ["ignore"], "audit", ["audit"], report);
  if (!Object.hasOwn(block, "ignore")) return { ignore: [] };
  const list = block.ignore;
  if (!Array.isArray(list)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      "audit.ignore must be a list, each entry { id, reason, expires }.",
      ["audit", "ignore"],
    );
    return { ignore: [] };
  }
  const ignore: AuditIgnoreEntry[] = [];
  for (const [index, item] of list.entries()) {
    const at: (string | number)[] = ["audit", "ignore", index];
    const name = `audit.ignore[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${name} must be a mapping carrying id, reason and expires.`,
        at,
      );
      continue;
    }
    const entry = item as Record<string, unknown>;
    reportUnknownKeys(entry, AUDIT_IGNORE_KEYS, "audit", at, report);
    const missing: string[] = [];
    const values: Record<string, string> = {};
    let valid = true;
    for (const key of AUDIT_IGNORE_KEYS) {
      const value = entry[key];
      if (value === undefined || value === null || value === "") {
        missing.push(key);
        continue;
      }
      if (typeof value !== "string") {
        report("WORKSPACE_INVALID_VALUE", `${name}.${key} must be a string.`, [...at, key]);
        valid = false;
        continue;
      }
      values[key] = value;
    }
    for (const key of missing) {
      valid = false;
      report(
        "WORKSPACE_INVALID_VALUE",
        key === "reason"
          ? `${name} has no reason. Every accepted advisory says why it is accepted, beside its id and expires.`
          : key === "expires"
            ? `${name} has no expires. Every accepted advisory is accepted until a date, written YYYY-MM-DD.`
            : `${name} has no id, so it accepts nothing.`,
        at,
      );
    }
    if (values.expires !== undefined && !isCalendarDate(values.expires)) {
      valid = false;
      report(
        "WORKSPACE_INVALID_VALUE",
        `${name}.expires "${values.expires}" is not a date. Write it as YYYY-MM-DD.`,
        [...at, "expires"],
      );
    }
    if (valid) {
      ignore.push({ index, id: values.id!, reason: values.reason!, expires: values.expires! });
    }
  }
  return { ignore };
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
