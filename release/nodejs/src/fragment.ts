/**
 * A release fragment — one pending change, written by an author.
 *
 * One file, several units, one body, carrying a kind per unit that drives both
 * the level and the changelog section the line lands under. Units are named by
 * their **workspace-relative path**, the same key the ledger and every
 * diagnostic use. A fragment written before units existed names them under
 * `modules:`; it is read as the same thing.
 *
 * Plain YAML validated here: build-time repo state the runtime never loads.
 */

import { Document, parseDocument } from "yaml";
import { isFragmentKind, type FragmentKind } from "./bump-level.js";

/** A unit's workspace-relative directory path — `modules/sql`, `kernel`. */
export type UnitKey = string;

export interface ReleaseFragment {
  /** Where this fragment was read from, workspace-relative — the file a
   *  diagnostic names and the file `apply` deletes once consumed. */
  readonly source: string;
  /** The directly-changed units this fragment declares, each with its kind. */
  readonly units: ReadonlyMap<UnitKey, FragmentKind>;
  /** The changelog line. */
  readonly body: string;
}

export class FragmentError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
  }
}

const UNITS_FIELD = "units";
/** The field a fragment written before units named its modules under. */
const LEGACY_UNITS_FIELD = "modules";

export function parseFragment(text: string, source: string): ReleaseFragment {
  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    throw new FragmentError(
      source,
      `${source} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FragmentError(source, `${source} must be a YAML mapping.`);
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== UNITS_FIELD && key !== LEGACY_UNITS_FIELD && key !== "body") {
      throw new FragmentError(
        source,
        `${source}: unknown field '${key}'. A fragment carries 'units:' and 'body:'.`,
      );
    }
  }
  if (UNITS_FIELD in record && LEGACY_UNITS_FIELD in record) {
    throw new FragmentError(
      source,
      `${source} carries both 'units:' and 'modules:'. 'modules:' is the older spelling of ` +
        `'units:'; move its entries into 'units:'.`,
    );
  }
  const field = LEGACY_UNITS_FIELD in record ? LEGACY_UNITS_FIELD : UNITS_FIELD;

  const rawUnits = record[field];
  if (rawUnits === null || typeof rawUnits !== "object" || Array.isArray(rawUnits)) {
    throw new FragmentError(
      source,
      `${source}: '${field}' must be a mapping of unit path to kind, e.g. { modules/sql: Fixed }.`,
    );
  }
  const units = new Map<UnitKey, FragmentKind>();
  for (const [key, kind] of Object.entries(rawUnits as Record<string, unknown>)) {
    if (!isFragmentKind(kind)) {
      throw new FragmentError(
        source,
        `${source}: '${key}' declares kind '${String(kind)}', which is not a release kind. ` +
          `Use Added, Changed, Deprecated, Removed, Fixed or Security.`,
      );
    }
    units.set(normalizeUnitKey(key), kind);
  }
  if (units.size === 0) {
    throw new FragmentError(
      source,
      `${source}: '${field}' is empty, so this fragment releases nothing. ` +
        `Name at least one unit by its workspace-relative path.`,
    );
  }

  const body = record.body;
  if (typeof body !== "string" || body.trim() === "") {
    throw new FragmentError(source, `${source}: 'body' must be the changelog line for this change.`);
  }

  return { source, units, body: body.trim() };
}

/** Render a fragment. Serialized rather than templated so a long body folds the
 *  way the YAML writer folds it, and a path needing quotes gets them. */
export function serializeFragment(units: ReadonlyMap<UnitKey, FragmentKind>, body: string): string {
  const doc = new Document({ [UNITS_FIELD]: Object.fromEntries(units), body });
  return doc.toString({ lineWidth: 88 });
}

/** Unit keys are POSIX-separated and carry no leading `./` or trailing slash, so
 *  the same directory written three ways is one key. */
export function normalizeUnitKey(key: string): UnitKey {
  return key.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
