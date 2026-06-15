import type { PortMapping } from "../../../model";

interface ManifestLike {
  kind: "Application" | "Library";
  ports?: Record<string, unknown>;
}

export interface DeclaredPortEntry {
  /** Logical name as declared in `ports:` (e.g. `http`). */
  name: string;
  /** Host env var the port number is bound to (e.g. `PORT`). */
  envVar: string;
  /** Transport protocol; defaults to tcp when the manifest omits it. */
  protocol: "tcp" | "udp";
  /** Declared default rendered as a hint and used when no value is supplied. */
  defaultText?: string;
}

/** Project an Application manifest's declared `ports:` block into the row model
 *  the Deployment tab renders. Each port binds a host env var — its number is
 *  edited as an env value, like a variable — plus a protocol. Library manifests
 *  carry no ports, so the tab is Application-only. */
export function extractDeclaredPorts(
  manifest: ManifestLike | null | undefined,
): DeclaredPortEntry[] {
  if (!manifest || manifest.kind !== "Application") return [];
  const block = manifest.ports;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const out: DeclaredPortEntry[] = [];
  for (const [name, raw] of Object.entries(block)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const envVar = typeof entry.env === "string" ? entry.env : null;
    if (!envVar) continue;
    out.push({
      name,
      envVar,
      protocol: entry.protocol === "udp" ? "udp" : "tcp",
      defaultText: formatDefault(entry.default),
    });
  }
  return out;
}

/** Resolve declared ports against the active env into the PortMapping list sent
 *  to the runner. A port's number is the env value, falling back to the declared
 *  default; entries resolving outside 1–65535 are dropped. */
export function resolveDeclaredPorts(
  manifest: ManifestLike | null | undefined,
  env: Record<string, string>,
): PortMapping[] {
  const out: PortMapping[] = [];
  for (const entry of extractDeclaredPorts(manifest)) {
    const raw = env[entry.envVar] ?? entry.defaultText;
    if (raw === undefined) continue;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ port, protocol: entry.protocol });
  }
  return out;
}

function formatDefault(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}
