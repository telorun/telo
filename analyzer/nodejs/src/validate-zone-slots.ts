/**
 * Static validation of the two execution-zone annotations themselves — the
 * strict half of the accessor split, mirroring `validate-ref-slots.ts`.
 *
 * `readProvidesZone` / `readRequiresZone` are deliberately lenient: they return
 * `undefined` for anything they cannot read. Without this pass that leniency is
 * silent in the worst possible direction, because the two annotations fail in
 * OPPOSITE ways:
 *
 *  - an unreadable **requires** annotation drops the requirement entirely, so a
 *    safety constraint the author wrote is never enforced — and the resource
 *    then throws `ERR_ZONE_REQUIRED` / `ERR_ZONE_ANNOTATION_MISSING` at
 *    dispatch. That is exactly the silent-non-enforcement `ZONE_PROVIDER_UNRESOLVED`
 *    exists to prevent, reached by a different route.
 *  - an unreadable **provides** annotation drops the discharge, so the pass
 *    reports `ZONE_REQUIREMENT_UNSATISFIED` on manifests that are correct.
 *
 * A third shape is worse than either: a `key` the analyzer skips but the kernel
 * accepts (a pointer with no leading `/` — the kernel's walk splits on `/` and
 * drops empty segments, so it resolves) makes the two halves disagree about what
 * the manifest MEANS, which is the one outcome neither severity can express.
 *
 * Scoping follows `X_TELO_REF_UNRESOLVED`: reported only for definitions in the
 * entry's own modules — a published dependency's slot is not the consumer's to
 * fix.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";

export interface ZoneSlotIssue {
  code: "ZONE_ANNOTATION_INVALID";
  manifest: ResourceManifest;
  /** Schema path of the annotated slot. */
  path: string;
  message: string;
}

const PROVIDES = "x-telo-provides-zone";
const REQUIRES = "x-telo-requires-zone";

/** A self-relative JSON Pointer, the only correlation-key spelling both halves
 *  read identically. `""` (whole document) is meaningless as a key, so a
 *  pointer must name at least one segment. */
function isPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length > 1;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return `a list`;
  if (value === null) return "null";
  return typeof value;
}

function checkProvides(
  raw: unknown,
  definition: ResourceManifest,
  path: string,
  issues: ZoneSlotIssue[],
): void {
  if (raw === true) return;
  if (isPointer(raw)) return;
  issues.push({
    code: "ZONE_ANNOTATION_INVALID",
    manifest: definition,
    path,
    message:
      `${PROVIDES} at '${path}' is ${describe(raw)}. It takes 'true' (the zone is ` +
      `uncorrelated) or a self-relative JSON Pointer naming this kind's own field ` +
      `whose resolved reference the zone carries as its correlation payload ` +
      `(e.g. '/connection'). It never names the zone — the zone a slot provides ` +
      `is always the declaring kind.`,
  });
}

function checkRequires(
  raw: unknown,
  definition: ResourceManifest,
  path: string,
  issues: ZoneSlotIssue[],
): void {
  const fail = (message: string): void => {
    issues.push({ code: "ZONE_ANNOTATION_INVALID", manifest: definition, path, message });
  };

  // Bare-string form: the zone kind, uncorrelated.
  if (typeof raw === "string") {
    if (!raw) fail(`${REQUIRES} at '${path}' is an empty string; name the providing kind.`);
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      `${REQUIRES} at '${path}' is ${describe(raw)}. It takes an alias-qualified kind name ` +
        `(e.g. 'Self.Transaction') or an object with 'zone', an optional 'key' and an ` +
        `optional 'reason'.`,
    );
    return;
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.zone !== "string" || !obj.zone) {
    fail(
      `${REQUIRES} at '${path}' declares no 'zone'. Name the providing kind with the same ` +
        `alias-qualified grammar 'extends' and 'x-telo-ref' use — '<Alias>.<Kind>', ` +
        `'Self.<Kind>', or 'Telo.<Kind>'. Without it the requirement is silently ` +
        `unenforced, and the resource throws at dispatch instead.`,
    );
  }

  if (obj.key !== undefined) {
    const pointers = Array.isArray(obj.key) ? obj.key : [obj.key];
    if (Array.isArray(obj.key) && obj.key.length === 0) {
      fail(`${REQUIRES} at '${path}' declares an empty 'key' list; omit 'key' instead.`);
    }
    for (const pointer of pointers) {
      if (isPointer(pointer)) continue;
      fail(
        `${REQUIRES} at '${path}' declares the correlation key ${describe(pointer)}, which is ` +
          `not a self-relative JSON Pointer. Write '/connection' (or a list of pointers tried ` +
          `in order, first hit winning). A bare field name is read as a pointer by the runtime ` +
          `but skipped by the checker, so the two halves would disagree about what this ` +
          `manifest means.`,
      );
    }
  }

  if (obj.reason !== undefined && typeof obj.reason !== "string") {
    fail(`${REQUIRES} at '${path}' declares a non-string 'reason'.`);
  }

  for (const key of Object.keys(obj)) {
    if (key === "zone" || key === "key" || key === "reason") {
      continue;
    }
    fail(
      `${REQUIRES} at '${path}' declares an unknown property '${key}'. The object form takes ` +
        `'zone', 'key' and 'reason'.`,
    );
  }
}

/** Walk a definition schema, reporting every zone annotation it cannot read.
 *  Pure-schema walk, so it needs a visited guard for cyclic `$defs`. */
function walkSchema(
  node: unknown,
  path: string,
  visited: Set<object>,
  definition: ResourceManifest,
  issues: ZoneSlotIssue[],
): void {
  if (!node || typeof node !== "object") return;
  if (visited.has(node as object)) return;
  visited.add(node as object);
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSchema(item, `${path}[${i}]`, visited, definition, issues));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj[PROVIDES] !== undefined) checkProvides(obj[PROVIDES], definition, path, issues);
  if (obj[REQUIRES] !== undefined) checkRequires(obj[REQUIRES], definition, path, issues);
  for (const [key, value] of Object.entries(obj)) {
    if (key === PROVIDES || key === REQUIRES || key === "examples" || key === "default") continue;
    walkSchema(value, path ? `${path}.${key}` : key, visited, definition, issues);
  }
}

/** Schema-level zone-annotation checks over one definition/abstract manifest. */
export function validateZoneSlotDeclarations(definition: ResourceManifest): ZoneSlotIssue[] {
  const issues: ZoneSlotIssue[] = [];
  const schema = (definition as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object") return issues;
  walkSchema(schema, "schema", new Set(), definition, issues);
  return issues;
}
