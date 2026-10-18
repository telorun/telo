/**
 * THE CAPABILITY ROSTER — the closed set of lifecycle roles a kind may declare
 * in `capability:`, and the one reader of what a `capability:` value means.
 *
 * A capability names a lifecycle a kernel implements and dispatches, so no module
 * can add one: the roster is the built-in `Telo.Abstract` entries of
 * `sdk/builtins/` carrying `declarable`, read from those entries alone and never
 * from a registry, where an author's abstract could appear. An entry is a ROLE
 * when its own `capability:` names itself (`Telo.Service` declares
 * `capability: Telo.Service`); `Telo.Template` is a role reserved for the
 * built-in document kinds, and `Telo.Executable` is no role at all — a slot
 * constraint. Both carry `declarable: false`.
 *
 * Shared by `telo check` (the registration pass, the throws allowlist), the Node
 * kernel (its definition registration, before schema validation) and the editor
 * support (capability completion and hover). The Rust analyzer reads the same
 * entries (`analyzer/rust/src/builtins.rs`) and words its refusals identically.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

import { BUILTIN_DOCUMENT_FILES } from "./builtin-entries/index.js";
import { nearestName } from "./nearest-name.js";

/** The built-in module's prefix: `Telo.<Name>`. */
const BUILTIN_PREFIX = "Telo.";

export interface CapabilityRosterEntry {
  /** `Telo.<Name>` — the entry's kind name, which a role's capability repeats. */
  readonly name: string;
  /** True when the entry's own `capability:` names itself. */
  readonly role: boolean;
  /** An authored `capability:` may name it. */
  readonly declarable: boolean;
  /** A kind of this role may declare `throws:`. */
  readonly throwsAllowed: boolean;
  readonly description: string;
}

export type CapabilityProblemCode = "CAPABILITY_UNKNOWN" | "CAPABILITY_NOT_DECLARABLE";

export interface CapabilityProblem {
  readonly code: CapabilityProblemCode;
  readonly message: string;
}

interface BuiltinDocument {
  kind?: unknown;
  metadata?: { name?: unknown; description?: unknown };
  capability?: unknown;
  declarable?: unknown;
  throwsAllowed?: unknown;
}

function builtinDocuments(): BuiltinDocument[] {
  return BUILTIN_DOCUMENT_FILES.map(([, data]) => data as BuiltinDocument);
}

const ROSTER: readonly CapabilityRosterEntry[] = builtinDocuments()
  .filter((doc) => doc.kind === "Telo.Abstract" && Object.hasOwn(doc, "declarable"))
  .map((doc) => {
    const name = `${BUILTIN_PREFIX}${String(doc.metadata?.name)}`;
    return {
      name,
      role: doc.capability === name,
      declarable: doc.declarable === true,
      throwsAllowed: doc.throwsAllowed === true,
      description: typeof doc.metadata?.description === "string" ? doc.metadata.description : "",
    };
  });

/** Every kind name the built-in vocabulary declares, `Telo.`-qualified. */
const BUILTIN_KIND_NAMES: ReadonlySet<string> = new Set(
  builtinDocuments().map((doc) => `${BUILTIN_PREFIX}${String(doc.metadata?.name)}`),
);

const DECLARABLE = ROSTER.filter((e) => e.role && e.declarable)
  .map((e) => e.name)
  .sort();
const THROWS_ALLOWED = ROSTER.filter((e) => e.role && e.throwsAllowed)
  .map((e) => e.name)
  .sort();

/** The roster: every built-in abstract carrying `declarable`, roles and the
 *  slot constraint alike. */
export function capabilityRoster(): readonly CapabilityRosterEntry[] {
  return ROSTER;
}

/** The names an authored `capability:` may hold, lexically sorted — the enum the
 *  `Telo.Definition` / `Telo.Abstract` schemas derive. */
export function declarableCapabilities(): readonly string[] {
  return DECLARABLE;
}

/** The roles a kind declaring `throws:` may hold, lexically sorted — the
 *  allowlist the same schemas derive. */
export function throwsAllowedCapabilities(): readonly string[] {
  return THROWS_ALLOWED;
}

/** True when `name` is a lifecycle role of the roster, declarable or not. */
export function isCapabilityRole(name: string): boolean {
  return ROSTER.some((e) => e.role && e.name === name);
}

/** A roster entry's description, or undefined for a name outside the roster. */
export function capabilityDescription(name: string): string | undefined {
  return ROSTER.find((e) => e.name === name)?.description;
}

/** Every `Telo.<Name>` kind the built-in vocabulary declares. */
export function builtinKindNames(): ReadonlySet<string> {
  return BUILTIN_KIND_NAMES;
}

/** `<Alias>.<Kind>` — the legacy spelling that named a module's kind. */
const ALIAS_QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

const roleList = (): string => DECLARABLE.join(", ");

/**
 * What is wrong with a `capability:` value, or undefined when it names a
 * declarable role (or is absent).
 *
 * `declaresExtends` says whether the same document declares `extends:` — the
 * one case where a kind named in `capability:` cannot be moved to `extends:`,
 * because a definition has one parent.
 */
export function capabilityProblem(
  value: unknown,
  declaresExtends: boolean,
): CapabilityProblem | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return {
      code: "CAPABILITY_UNKNOWN",
      message: `capability must name a lifecycle role — one of: ${roleList()}.`,
    };
  }
  const entry = ROSTER.find((e) => e.name === value);
  if (entry?.role && entry.declarable) return undefined;
  if (entry) {
    return {
      code: "CAPABILITY_NOT_DECLARABLE",
      message:
        `'${value}' cannot be declared as a capability: ${entry.description} ` +
        `Declare one of: ${roleList()}.`,
    };
  }
  if (BUILTIN_KIND_NAMES.has(value)) {
    return {
      code: "CAPABILITY_UNKNOWN",
      message:
        `'${value}' is a built-in kind, not a lifecycle role. To specialize it, write ` +
        `'extends: ${value}'; capability names a role — one of: ${roleList()}.`,
    };
  }
  if (value.startsWith(BUILTIN_PREFIX)) {
    const suggestion = nearestName(value, DECLARABLE);
    return {
      code: "CAPABILITY_UNKNOWN",
      message:
        `'${value}' is not a capability.${suggestion ? ` Did you mean '${suggestion}'?` : ""} ` +
        `A capability names a lifecycle role — one of: ${roleList()}.`,
    };
  }
  if (ALIAS_QUALIFIED.test(value)) {
    return {
      code: "CAPABILITY_UNKNOWN",
      message: declaresExtends
        ? `'${value}' names a kind, not a lifecycle role, and this definition already declares ` +
          `'extends:' — a definition has one parent, declared in 'extends:'. Remove ` +
          `'capability: ${value}', or declare it in 'extends:' in place of the other. A capability ` +
          `names a role — one of: ${roleList()}.`
        : `'${value}' names a kind, not a lifecycle role. A kind this one specializes is declared ` +
          `in 'extends: ${value}'; capability names a role — one of: ${roleList()}.`,
    };
  }
  const short = nearestName(
    value,
    DECLARABLE.map((name) => name.slice(BUILTIN_PREFIX.length)),
  );
  return {
    code: "CAPABILITY_UNKNOWN",
    message:
      `'${value}' is not a capability: a lifecycle role is written '${BUILTIN_PREFIX}<Role>'.` +
      `${short ? ` Did you mean '${BUILTIN_PREFIX}${short}'?` : ""} One of: ${roleList()}.`,
  };
}
