import { BUILTIN_DOCUMENT_FILES } from "./builtin-entries/index.js";

/**
 * PUBLIC ADDRESS NEEDS — the two kernel-declared need types an application
 * declares the addresses it is reached at with, and the one reader of what
 * their parameters, labels and host patterns mean. Shared by `telo check` (the
 * need table) and the kernel (deriving addresses from the host's templates,
 * refusing collisions), so the two cannot read an address differently.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const PUBLIC_URL_TYPE = "Telo.PublicUrl";
export const PUBLIC_HOST_PATTERN_TYPE = "Telo.PublicHostPattern";

/** The host values a template-mode host sets. */
export const PUBLIC_URL_TEMPLATE_ENV = "TELO_HOST_PUBLIC_URL_TEMPLATE";
export const PUBLIC_URL_SECONDARY_TEMPLATE_ENV = "TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE";
export const PUBLIC_URL_HOST_VALUES = [PUBLIC_URL_TEMPLATE_ENV, PUBLIC_URL_SECONDARY_TEMPLATE_ENV] as const;

export function isAddressNeedType(type: string | undefined): boolean {
  return type === PUBLIC_URL_TYPE || type === PUBLIC_HOST_PATTERN_TYPE;
}

/** `<scheme>://<hostname pattern>[:<port>]` — the pattern origin a
 *  `Telo.PublicHostPattern` holds. `*` only at the start of the first label:
 *  the whole label (`*.<rest>`) or a prefix of it (`*<text>.<rest>`). Read from
 *  the need type's own entry (`sdk/builtins/PublicHostPattern.json`), which is
 *  what a fulfilment's `pattern` field is validated against. */
export const HOST_PATTERN_ORIGIN: string = (() => {
  const entry = BUILTIN_DOCUMENT_FILES.find(([file]) => file === "PublicHostPattern.json")?.[1] as
    | { fields?: { pattern?: { pattern?: unknown } } }
    | undefined;
  const pattern = entry?.fields?.pattern?.pattern;
  if (typeof pattern !== "string") {
    throw new Error(
      "sdk/builtins/PublicHostPattern.json declares no `fields.pattern.pattern` — the host-pattern grammar is read from it.",
    );
  }
  return pattern;
})();

/** The keys of `ports:` a module doc's own address needs name — each a use of
 *  that port, as a `ports.<key>` read is. */
export function addressNeedPorts(moduleDoc: Record<string, unknown>): string[] {
  const needs = moduleDoc.needs;
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) return [];
  const ports: string[] = [];
  for (const need of Object.values(needs as Record<string, unknown>)) {
    if (!need || typeof need !== "object") continue;
    const { kind, parameters } = need as { kind?: unknown; parameters?: unknown };
    if (typeof kind !== "string" || !isAddressNeedType(kind)) continue;
    const port = (parameters as { port?: unknown } | undefined)?.port;
    if (typeof port === "string") ports.push(port);
  }
  return ports;
}

/** A need's label in a derived hostname: its name lowercased, `_` written `-`. */
export function addressLabel(needName: string): string {
  return needName.toLowerCase().replace(/_/g, "-");
}

/** Why a first DNS label is not one, or undefined when it is. */
export function invalidLabelReason(label: string): string | undefined {
  if (label.length === 0) return "it is empty";
  if (label.length > 63) return `it is ${label.length} octets long, over the 63 a DNS label holds`;
  if (label.startsWith("-") || label.endsWith("-")) return "it starts or ends with '-'";
  if (!/^[a-z0-9-]+$/i.test(label)) return "it holds a character a DNS label does not";
  return undefined;
}

/** A host as matched: lowercased, a trailing dot dropped. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/** A parsed host pattern: what stands before the literal suffix, and the suffix. */
export interface HostPattern {
  /** `label` — `*` is the whole first label; `prefix` — part of it. */
  form: "label" | "prefix";
  /** Everything after the `*`, lowercased. */
  suffix: string;
}

/** Read the host of a pattern origin, or undefined when it is not one. */
export function parseHostPatternOrigin(origin: string): { scheme: string; pattern: HostPattern; port?: number } | undefined {
  if (!new RegExp(HOST_PATTERN_ORIGIN).test(origin)) return undefined;
  const match = /^(https?):\/\/(\*[^:]*)(?::([0-9]+))?$/.exec(origin)!;
  const host = normalizeHost(match[2]!);
  const pattern = parseHostPattern(host)!;
  return { scheme: match[1]!, pattern, ...(match[3] ? { port: Number(match[3]) } : {}) };
}

/** Read a hostname pattern (`*.a.example`, `*-a.example`). The same reading as
 *  `http-dispatch`'s `hostnameMatcher`; both are held to one vector table. */
export function parseHostPattern(host: string): HostPattern | undefined {
  if (!host.startsWith("*")) return undefined;
  const suffix = normalizeHost(host.slice(1));
  if (suffix.startsWith(".") && suffix.length > 1) return { form: "label", suffix };
  if (/^[a-z0-9-]+\.[a-z0-9]/.test(suffix)) return { form: "prefix", suffix };
  return undefined;
}
