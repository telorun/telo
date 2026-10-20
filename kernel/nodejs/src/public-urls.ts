import {
  addressLabel,
  invalidLabelReason,
  isAddressNeedType,
  normalizeHost,
  parseHostPatternOrigin,
  PUBLIC_HOST_PATTERN_TYPE,
  PUBLIC_URL_HOST_VALUES,
  PUBLIC_URL_SECONDARY_TEMPLATE_ENV,
  PUBLIC_URL_TEMPLATE_ENV,
  PUBLIC_URL_TYPE,
  type NeedTableEntry,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";

/**
 * The kernel half of the address needs (`Telo.PublicUrl`, `Telo.PublicHostPattern`):
 * deriving a `Telo.PublicUrl` from the host's two templates, refusing two
 * addresses no host could route apart, and what a runner is told to route.
 * The rules a manifest is held to statically are the analyzer's
 * (`public-address.ts`, the need table).
 */

/** The root's own address needs: every one is a root need, the type being
 *  supplied only through one. */
function rootAddressEntries(entries: readonly NeedTableEntry[]): NeedTableEntry[] {
  return entries.filter((entry) => !entry.via && isAddressNeedType(entry.need.type));
}

function parametersOf(entry: NeedTableEntry): Record<string, unknown> {
  const parameters = entry.need.parameters;
  return parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)
    : {};
}

function portKeyOf(entry: NeedTableEntry): string | undefined {
  const port = parametersOf(entry).port;
  return typeof port === "string" ? port : undefined;
}

const ORIGIN_TEMPLATE = /^https?:\/\/[^/?#@\s]+\/?$/;

/** Refuse a host value that is not an origin template, naming the variable and
 *  never its value. */
function readTemplate(
  env: Record<string, string | undefined>,
  name: string,
  mustHold: string[],
  mustNotHold: string[] = [],
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const refuse = (why: string): never => {
    throw new RuntimeError("ERR_NEED_HOST_VALUE_INVALID", `Host value ${name} is not usable: ${why}.`);
  };
  if (!ORIGIN_TEMPLATE.test(raw)) {
    refuse("it must be an http or https origin with nothing after the host or port (`https://{port}-s1.example.dev`)");
  }
  for (const placeholder of mustHold) {
    if (!raw.includes(placeholder)) refuse(`it must hold ${placeholder} in its host`);
  }
  for (const placeholder of mustNotHold) {
    if (raw.includes(placeholder)) refuse(`it must not hold ${placeholder}, which only the secondary template fills`);
  }
  const sample = raw.replace(/\{port\}/g, "8080").replace(/\{label\}/g, "x");
  if (/[{}]/.test(sample)) refuse("it holds a placeholder other than {port} and {label}");
  try {
    new URL(sample);
  } catch {
    refuse("it is not a URL once its placeholders are filled");
  }
  return raw.replace(/\/$/, "");
}

/**
 * The environment the root's needs are read from, with every `Telo.PublicUrl`
 * nothing else supplies answered from the host's templates: a need's base is
 * the main template with `{port}` filled; among the needs sharing a base the
 * primary — or, with no primary there, the only one — gets it, and every other
 * gets the secondary template with `{label}` and `{port}` filled. A need the
 * templates do not answer is left as it is, for the read to refuse.
 */
export function withDerivedPublicUrls(
  entries: readonly NeedTableEntry[],
  env: Record<string, string | undefined>,
  ports: Readonly<Record<string, number>>,
): Record<string, string | undefined> {
  const urls = rootAddressEntries(entries).filter((entry) => entry.need.type === PUBLIC_URL_TYPE);
  if (urls.length === 0) return env;
  const main = readTemplate(env, PUBLIC_URL_TEMPLATE_ENV, [], ["{label}"]);
  const secondary = readTemplate(env, PUBLIC_URL_SECONDARY_TEMPLATE_ENV, ["{label}"]);
  if (main === undefined) return env;
  const groups = new Map<string, NeedTableEntry[]>();
  for (const entry of urls) {
    const port = portKeyOf(entry);
    const number = port !== undefined ? ports[port] : undefined;
    if (number === undefined) continue;
    const base = main.replace(/\{port\}/g, String(number));
    groups.set(base, [...(groups.get(base) ?? []), entry]);
  }
  const derived: Record<string, string> = {};
  for (const [base, members] of groups) {
    const primary = members.find((entry) => parametersOf(entry).primary === true);
    const holder = primary ?? (members.length === 1 ? members[0] : undefined);
    for (const entry of members) {
      const field = entry.fields?.url;
      if (!field || (env[field.env] !== undefined && env[field.env] !== "")) continue;
      if (entry === holder) {
        derived[field.env] = base;
        continue;
      }
      if (secondary === undefined) continue;
      const number = ports[portKeyOf(entry)!]!;
      const label = addressLabel(entry.need.name);
      const url = secondary.replace(/\{label\}/g, label).replace(/\{port\}/g, String(number));
      const firstLabel = new URL(url).hostname.split(".")[0] ?? "";
      const why = invalidLabelReason(firstLabel);
      if (why) {
        throw new RuntimeError(
          "ERR_NEED_HOST_VALUE_INVALID",
          `Host value ${PUBLIC_URL_SECONDARY_TEMPLATE_ENV} cannot answer need '${entry.path.join(".")}': ` +
            `the first label of the address it derives is not a DNS label — ${why}. Rename the need, ` +
            `or supply it through ${field.env}.`,
        );
      }
      derived[field.env] = url;
    }
  }
  return Object.keys(derived).length === 0 ? env : { ...env, ...derived };
}

/**
 * The root `Telo.PublicUrl` needs the host's main template would answer once
 * the port each names has a value, while it has none: what such a need resolves
 * to depends on that port, so it is neither refused nor asked for until then.
 */
export function publicUrlsAwaitingPorts(
  entries: readonly NeedTableEntry[],
  env: Record<string, string | undefined>,
  ports: Readonly<Record<string, number>>,
): Set<NeedTableEntry> {
  const awaiting = new Set<NeedTableEntry>();
  const main = env[PUBLIC_URL_TEMPLATE_ENV];
  if (main === undefined || main === "") return awaiting;
  for (const entry of rootAddressEntries(entries)) {
    if (entry.need.type !== PUBLIC_URL_TYPE) continue;
    const port = portKeyOf(entry);
    const field = entry.fields?.url;
    if (port === undefined || ports[port] !== undefined || !field) continue;
    if (env[field.env] !== undefined && env[field.env] !== "") continue;
    awaiting.add(entry);
  }
  return awaiting;
}

/** One address need's resolved place: its host (or pattern) and port. */
export interface ResolvedAddress {
  need: string;
  type: string;
  /** The key of `ports:` the need names. */
  port: string;
  /** A URL's host, or a pattern's host pattern (`*.a.example`). */
  host: string;
  /** The port a client reaches the address on: the URL's own, or its scheme's. */
  effectivePort: number;
  /** For a pattern: its form and literal suffix. */
  pattern?: { form: "label" | "prefix"; suffix: string };
  customDomains: boolean;
}

function urlMembers(value: unknown): { scheme?: string; host?: string; port?: unknown } {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Every root address need's resolved place, refusing an address that cannot be
 * one — a URL with no host — and two no host could route apart: on one port
 * two URLs with the same host, or two patterns with the same suffix and form
 * (matching ignores the port); on two ports, the same host or pattern on the
 * same effective port.
 */
export function resolveAddresses(
  entries: readonly NeedTableEntry[],
  valueOf: (entry: NeedTableEntry) => Record<string, unknown> | null | undefined,
): ResolvedAddress[] {
  const resolved: ResolvedAddress[] = [];
  for (const entry of rootAddressEntries(entries)) {
    const values = valueOf(entry);
    const port = portKeyOf(entry);
    if (!values || port === undefined) continue;
    const customDomains = parametersOf(entry).customDomains === true;
    const name = entry.path.join(".");
    if (entry.need.type === PUBLIC_HOST_PATTERN_TYPE) {
      const read = typeof values.pattern === "string" ? parseHostPatternOrigin(values.pattern) : undefined;
      if (!read) {
        throw new RuntimeError(
          "ERR_MANIFEST_VALIDATION_FAILED",
          `Need '${name}' (type '${PUBLIC_HOST_PATTERN_TYPE}'): its pattern is not a host pattern ` +
            `origin (\`https://*.tenants.example\`, \`https://*-tenants.example\`).`,
        );
      }
      resolved.push({
        need: name,
        type: entry.need.type,
        port,
        host: `*${read.pattern.suffix}`,
        effectivePort: read.port ?? (read.scheme === "https" ? 443 : 80),
        pattern: read.pattern,
        customDomains,
      });
      continue;
    }
    const url = urlMembers(values.url);
    if (typeof url.host !== "string" || url.host === "") {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `Need '${name}' (type '${PUBLIC_URL_TYPE}'): its url has no host. An address is an http ` +
          `or https origin naming a host.`,
      );
    }
    const explicit = url.port === undefined ? undefined : Number(url.port);
    resolved.push({
      need: name,
      type: PUBLIC_URL_TYPE,
      port,
      host: normalizeHost(url.host),
      effectivePort: explicit ?? (url.scheme === "https" ? 443 : 80),
      customDomains,
    });
  }
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (a.type !== b.type || a.host !== b.host) continue;
      if (a.port !== b.port && a.effectivePort !== b.effectivePort) continue;
      const where =
        a.port === b.port
          ? `on port '${a.port}'`
          : `on ports '${a.port}' and '${b.port}', both reached on ${a.effectivePort}`;
      throw new RuntimeError(
        "ERR_NEED_PUBLIC_URL_COLLISION",
        `Needs '${a.need}' and '${b.need}' resolve to the same ${a.pattern ? "host pattern" : "host"} ` +
          `'${a.host}' ${where}, which no host can route apart. Give one of them another host.`,
      );
    }
  }
  return resolved;
}

/** What a runner is told per port: each `Telo.PublicUrl` naming it and the
 *  host it resolved to. */
export function publicUrlsByPort(
  addresses: readonly ResolvedAddress[],
): Map<string, Array<{ need: string; host: string }>> {
  const out = new Map<string, Array<{ need: string; host: string }>>();
  for (const address of addresses) {
    if (address.type !== PUBLIC_URL_TYPE) continue;
    out.set(address.port, [...(out.get(address.port) ?? []), { need: address.need, host: address.host }]);
  }
  return out;
}

/** The environment a started child application inherits: the host values that
 *  answer the parent's addresses are the parent's, never the child's. */
export function withoutPublicUrlHostValues(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!PUBLIC_URL_HOST_VALUES.some((name) => name in env)) return env;
  const out = { ...env };
  for (const name of PUBLIC_URL_HOST_VALUES) delete out[name];
  return out;
}
