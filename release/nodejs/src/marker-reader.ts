/**
 * Reading `telo-workspace.yaml` leniently.
 *
 * The marker's location is the anchor for every unit key, ledger entry and
 * fragment path, and every field lives in a block scoped to what it governs.
 * The reader returns everything it could read plus everything it found wrong,
 * each anchored at a key path, because an editor wants all of them and a
 * command wants to exit on the first. Which are fatal is the CALLER's policy.
 *
 * These primitives read any block against its declared shape, so a host whose
 * marker carries blocks of its own (`env:`) reads them the same way.
 */

import { parseDocument } from "yaml";
import type { WorkspaceEntrySchema, WorkspaceKeySchema } from "./marker-schema.js";

export const WORKSPACE_FILENAME = "telo-workspace.yaml";

export type WorkspaceDiagnosticCode =
  | "WORKSPACE_UNKNOWN_KEY"
  | "WORKSPACE_MODULES_MOVED"
  | "WORKSPACE_INVALID_VALUE"
  | "WORKSPACE_ECOSYSTEM_UNAVAILABLE"
  | "WORKSPACE_UNIT_VERSION_UNRESOLVED"
  | "WORKSPACE_UNIT_PAYLOAD_EMPTY"
  | "WORKSPACE_ANCHOR_INVALID"
  | "WORKSPACE_ANCHOR_CLAIMED"
  | "WORKSPACE_ENTRY_MATCHES_NOTHING"
  | "WORKSPACE_ENTRY_SHADOWED"
  | "WORKSPACE_MARKER_SHADOWED";

export interface WorkspaceDiagnostic {
  readonly code: WorkspaceDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** Key path from the document root (`["release", "units", 2, "ecosystem"]`). */
  readonly path: readonly (string | number)[];
}

export type MarkerReport = (
  code: WorkspaceDiagnosticCode,
  message: string,
  path: (string | number)[],
  severity?: "error" | "warning",
) => void;

export class WorkspaceConfigError extends Error {}

/** The marker's root mapping, or `undefined` with the reason reported. A marker
 *  whose whole content is comments reads as an empty mapping. */
export function parseMarker(
  text: string,
  where: string,
  report: MarkerReport,
): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
    return undefined;
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    report("WORKSPACE_INVALID_VALUE", `${where} must be a YAML mapping.`, []);
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** One entry of an `entry[]` list as read: where it sits, whether it was a bare
 *  string, and its fields — the entry's key always among them. */
export interface ReadEntry {
  readonly index: number;
  readonly bare: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Read one block against its declared shape — the plain types only. The
 * declared `type` dispatches, so a new plain key is one schema entry.
 */
export function readSchemaBlock(
  block: Record<string, unknown>,
  properties: Readonly<Record<string, WorkspaceKeySchema>>,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): Record<string, unknown> {
  reportUnknownKeys(block, Object.keys(properties), where, at, report);
  return readKnownKeys(block, properties, where, at, report);
}

/** Read the plain-typed keys of `properties` out of `block`, reporting nothing
 *  about keys it does not declare. */
export function readKnownKeys(
  block: Record<string, unknown>,
  properties: Readonly<Record<string, WorkspaceKeySchema>>,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const value = readPlainValue(block[name], schema, where, [...at, name], report);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function readPlainValue(
  raw: unknown,
  schema: WorkspaceKeySchema,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): unknown {
  switch (schema.type) {
    case "string":
      return readString(raw, where, at, report);
    case "boolean":
      return readBoolean(raw, where, at, report);
    case "string[]":
      return readStringList(raw, where, at, report);
    case "entry[]":
      return readEntries(raw, schema, where, at, report);
    default:
      return undefined;
  }
}

/**
 * A list whose entries are a bare string or a mapping carrying the entry's key
 * plus the keys it adds. An entry that cannot be read is reported and left out.
 */
export function readEntries(
  raw: unknown,
  schema: WorkspaceKeySchema,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): readonly ReadEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const entry = schema.entry as WorkspaceEntrySchema;
  const name = at.join(".");
  const example = schema.examples?.length ? `, e.g. [${schema.examples.join(", ")}]` : "";
  if (!Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${name}' must be a list, each entry a string or a mapping carrying '${entry.key}:'${example}.`,
      at,
    );
    return undefined;
  }

  const entries: ReadEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const itemAt = [...at, index];
    if (typeof item === "string") {
      entries.push({ index, bare: true, fields: { [entry.key]: item } });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: '${name}' entry ${index} must be a string, or a mapping carrying ` +
          `'${entry.key}:' plus the keys it adds.`,
        itemAt,
      );
      continue;
    }
    reportNullKeys(item as Record<string, unknown>, entry, where, itemAt, report);
    const read = readSchemaBlock(item as Record<string, unknown>, entry.properties, where, itemAt, report);
    if (read[entry.key] === undefined) {
      if (!Object.hasOwn(item, entry.key)) {
        report(
          "WORKSPACE_INVALID_VALUE",
          `${where}: '${name}' entry ${index} declares no '${entry.key}:', so it names nothing.`,
          itemAt,
        );
      }
      continue;
    }
    entries.push({ index, bare: false, fields: read });
  }
  return entries;
}

/**
 * A key written with no value is not an absence: dropping it would either name
 * nothing or silently take the default (`sensitive:` read as false).
 */
export function reportNullKeys(
  item: Record<string, unknown>,
  entry: WorkspaceEntrySchema,
  where: string,
  itemAt: (string | number)[],
  report: MarkerReport,
): void {
  for (const [key, keySchema] of Object.entries(entry.properties)) {
    if (!Object.hasOwn(item, key) || item[key] !== null) continue;
    const keyName = [...itemAt, key].join(".");
    const message =
      key === entry.key
        ? `${where}: '${keyName}' has no value, so the entry names nothing.`
        : keySchema.type === "boolean"
          ? `${where}: '${keyName}' must be true or false.`
          : keySchema.type === "string[]"
            ? `${where}: '${keyName}' must be a list of strings.`
            : keySchema.type === "string"
              ? `${where}: '${keyName}' must be a string.`
              : `${where}: '${keyName}' has no value.`;
    report("WORKSPACE_INVALID_VALUE", message, [...itemAt, key]);
  }
}

export function reportUnknownKeys(
  block: Record<string, unknown>,
  names: readonly string[],
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): void {
  for (const key of Object.keys(block)) {
    if (names.includes(key)) continue;
    const near = nearMiss(key, names);
    report(
      "WORKSPACE_UNKNOWN_KEY",
      `${where}: unknown key '${[...at, key].join(".")}'.` +
        (near ? ` Did you mean '${near}'?` : ` Known keys: ${names.map((n) => `'${n}'`).join(", ")}.`),
      [...at, key],
    );
  }
}

export function readString(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be a string.`, at);
    return undefined;
  }
  if (raw === "") {
    // An empty value would fall through to the next rung of a cascade and
    // settle something the author did not name.
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' is empty.`, at);
    return undefined;
  }
  return raw;
}

export function readBoolean(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be true or false.`, at);
    return undefined;
  }
  return raw;
}

export function readStringList(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be a list of strings.`, at);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string") {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' entry ${index} must be a string.`, [
        ...at,
        index,
      ]);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** One edit apart, case-insensitively — enough to separate a typo from a key
 *  this reader is simply too old to know. */
export function nearMiss(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  return known.find((name) => name !== key && editDistanceAtMostOne(lower, name.toLowerCase()));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The diagnostics anchored inside one top-level block, plus the ones anchored
 *  at the document itself — those are every block's problem. */
export function diagnosticsFor(
  diagnostics: readonly WorkspaceDiagnostic[],
  block: string,
): readonly WorkspaceDiagnostic[] {
  return diagnostics.filter((d) => d.path.length === 0 || d.path[0] === block);
}

export function hasError(diagnostics: readonly WorkspaceDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
