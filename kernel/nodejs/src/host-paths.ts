/**
 * **`Telo.HostPath` at runtime** — the kernel's half of the value type whose
 * values are absolute paths on the host.
 *
 * Two rules, one per direction a value arrives from:
 *
 *  - text the HOST supplies (an Application variable's env value, or the
 *    `default:` standing in for one) may be relative, and is resolved against
 *    the entry's `fromHost` anchor — the one place a relative path is read;
 *  - everything else must already be absolute. A literal is refused by the
 *    `x-telo-type` keyword at validation; a compile-eval expression is only a
 *    placeholder then, so its RESULT is checked here, once it exists.
 */
import fs from "node:fs";
import path from "node:path";
import {
  HOST_ENTRY_KINDS,
  isAbsoluteHostPath,
  RuntimeError,
  VALUE_TYPES,
  type HostEntryKind,
} from "@telorun/sdk";
import {
  decodePlainLiterals,
  describeHostEntry,
  type ExternalSchemaResolver,
  hostAnchorFor,
  hostEntryAt,
  hostPathRelativeMessage,
  mapTextLeaves,
} from "@telorun/analyzer";

/** The one host-path value type, named in the refusal. */
const HOST_PATH_TYPE = VALUE_TYPES.get("Telo.HostPath")!;

/** Each `fromHost` anchor mapped to what it means in this runtime. */
const HOST_ANCHOR_RESOLVERS: Readonly<Record<string, (text: string) => string>> = {
  "working-directory": (text) => path.resolve(process.cwd(), text),
};

// An anchor this runtime cannot map would leave a relative host value relative,
// and every slot of that type would then refuse the operator's input — so it is
// a startup error, the rule an unmapped value-type binding follows.
for (const entry of VALUE_TYPES.values()) {
  if (entry.fromHost !== undefined && !(entry.fromHost in HOST_ANCHOR_RESOLVERS)) {
    throw new Error(
      `Value type '${entry.name}' anchors host values at '${entry.fromHost}', which this ` +
        `kernel cannot resolve (it knows: ${Object.keys(HOST_ANCHOR_RESOLVERS).join(", ")}).`,
    );
  }
}

/** Each host-entry token mapped to this runtime's filesystem query, links followed. */
const HOST_ENTRY_QUERIES: Readonly<Record<string, (stat: fs.Stats) => boolean>> = {
  file: (stat) => !stat.isDirectory(),
  directory: (stat) => stat.isDirectory(),
};

// A token this runtime cannot map would leave every slot declaring it unchecked.
for (const kind of HOST_ENTRY_KINDS) {
  if (!(kind in HOST_ENTRY_QUERIES)) {
    throw new Error(`Host-entry '${kind}' has no filesystem query in this kernel.`);
  }
}

/** What is at an absolute path: the token whose query it answers, undefined
 *  when nothing is there, or why the filesystem would not say. */
function hostEntryAtPath(text: string): HostEntryKind | { unreadable: string } | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return { unreadable: code ?? (error as Error).message };
  }
  return HOST_ENTRY_KINDS.find((kind) => HOST_ENTRY_QUERIES[kind]!(stat));
}

/** One host path in a value whose slot says what it names, and that is the
 *  other kind of entry — or that the filesystem would not tell about. */
export interface HostEntryMismatch {
  pointer: string;
  text: string;
  wanted: HostEntryKind;
  /** What is there, when the path could be read. */
  found?: HostEntryKind;
  /** Why the path could not be read (`EACCES`), when it could not. */
  unreadable?: string;
}

/**
 * Every absolute host path in `value` whose slot declares what it names
 * (`entry: file | directory`) and that exists as the other kind, or cannot be
 * read. An absent path is never one: what uses it may create it.
 */
export function hostEntryMismatches(
  value: unknown,
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
): HostEntryMismatch[] {
  const out: HostEntryMismatch[] = [];
  mapTextLeaves(
    value,
    schema,
    (slot, text, pointer) => {
      if (hostAnchorFor(slot, text) === undefined || !isAbsoluteHostPath(text)) return text;
      const wanted = hostEntryAt(slot);
      if (wanted === undefined) return text;
      const found = hostEntryAtPath(text);
      if (typeof found === "object") out.push({ pointer, text, wanted, unreadable: found.unreadable });
      else if (found !== undefined && found !== wanted) out.push({ pointer, text, wanted, found });
      return text;
    },
    external,
  );
  return out;
}

const declaringSchemas = new WeakMap<object, boolean>();

/** Whether a schema — through every reference it makes — declares a host path's
 *  entry anywhere, so a kind declaring none walks nothing at creation. */
function declaresHostEntry(schema: Record<string, any>, external?: ExternalSchemaResolver): boolean {
  const known = declaringSchemas.get(schema);
  if (known !== undefined) return known;
  const seen = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (!Array.isArray(node)) {
      const record = node as Record<string, unknown>;
      if (hostEntryAt(record) !== undefined) return true;
      if (typeof record.$ref === "string" && !record.$ref.startsWith("#") && visit(external?.(record.$ref))) {
        return true;
      }
    }
    return Object.values(node).some(visit);
  };
  const declares = visit(schema);
  declaringSchemas.set(schema, declares);
  return declares;
}

/** How a mismatch reads after its subject. */
export function hostEntryMismatchText(mismatch: HostEntryMismatch): string {
  const wanted = `takes the path of ${describeHostEntry(mismatch.wanted)}`;
  return mismatch.found === undefined
    ? `${wanted}, but what is at '${mismatch.text}' cannot be read (${mismatch.unreadable})`
    : `${wanted}, but '${mismatch.text}' is ${describeHostEntry(mismatch.found)}`;
}

/**
 * Refuse a host path a resource holds — written as a module file, computed by a
 * compile-eval expression, or read from a variable — that exists and is the
 * other kind of entry than its slot names (`ERR_HOST_PATH_ENTRY_MISMATCH`), or
 * that the filesystem would not tell about (`ERR_HOST_PATH_UNREADABLE`).
 */
export function refuseMisplacedHostEntries(
  resource: Record<string, unknown>,
  schema: Record<string, any>,
  label: string,
  external?: ExternalSchemaResolver,
): void {
  if (!declaresHostEntry(schema, external)) return;
  const [mismatch] = hostEntryMismatches(resource, schema, external);
  if (!mismatch) return;
  throw new RuntimeError(
    mismatch.found === undefined ? "ERR_HOST_PATH_UNREADABLE" : "ERR_HOST_PATH_ENTRY_MISMATCH",
    `${label}: '${mismatch.pointer}' ${hostEntryMismatchText(mismatch)}.`,
  );
}

/**
 * Decode a host-supplied value's plain-encoded text AND resolve every relative
 * host path in it against its anchor, in place. The whole value may be the path
 * (`x-telo-type: Telo.HostPath`), or a field of a JSON-decoded one.
 */
export function decodeHostValue(
  value: unknown,
  schema: Record<string, any>,
  external?: ExternalSchemaResolver,
): unknown {
  const decoded = decodePlainLiterals(value, schema, external);
  return mapTextLeaves(
    decoded,
    schema,
    (slot, text) => {
      const anchor = hostAnchorFor(slot, text);
      return anchor === undefined ? text : HOST_ANCHOR_RESOLVERS[anchor]!(text);
    },
    external,
  );
}

/**
 * Refuse a relative host path a compile-eval expression produced, naming where.
 * Literals never reach this — validation refused them first — so what is left
 * is an expression whose result the placeholder could not predict.
 */
export function refuseRelativeHostPaths(
  resource: Record<string, unknown>,
  schema: Record<string, any>,
  label: string,
  external?: ExternalSchemaResolver,
): void {
  mapTextLeaves(
    resource,
    schema,
    (slot, text) => {
      if (hostAnchorFor(slot, text) === undefined || isAbsoluteHostPath(text)) return text;
      throw new RuntimeError(
        "ERR_HOST_PATH_RELATIVE",
        `${label}: '${text}' ${hostPathRelativeMessage(HOST_PATH_TYPE)}.`,
      );
    },
    external,
  );
}
