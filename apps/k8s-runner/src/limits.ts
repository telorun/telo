import type { LimitCeilings } from "./config.js";

/**
 * Effective per-session resource limits. Requests may ask for LESS than the
 * ceiling but never MORE — `min(requested, ceiling)`. Without a control plane
 * the editor talks to the runner directly, so a raisable limit would void the
 * cap; clamp-down-only is the load-bearing invariant.
 */
export interface ResolvedLimits {
  cpu: string;
  memory: string;
  ttlSeconds: number;
  ephemeralStorage: string;
}

export interface RequestedLimits {
  cpu?: string;
  memory?: string;
  ttlSeconds?: number;
  ephemeralStorage?: string;
}

export function clampLimits(
  ceilings: LimitCeilings,
  requested: RequestedLimits | undefined,
): ResolvedLimits {
  return {
    cpu: clampQuantity(ceilings.cpu, requested?.cpu, parseCpuMillis),
    memory: clampQuantity(ceilings.memory, requested?.memory, parseMemoryBytes),
    ephemeralStorage: clampQuantity(
      ceilings.ephemeralStorage,
      requested?.ephemeralStorage,
      parseMemoryBytes,
    ),
    ttlSeconds:
      requested?.ttlSeconds && requested.ttlSeconds > 0
        ? Math.min(requested.ttlSeconds, ceilings.ttlSeconds)
        : ceilings.ttlSeconds,
  };
}

/** Returns `requested` only when it parses AND is <= ceiling; otherwise the
 *  ceiling. Any unparseable/oversized request silently clamps to the cap. */
function clampQuantity(
  ceiling: string,
  requested: string | undefined,
  parse: (q: string) => number | null,
): string {
  if (!requested) return ceiling;
  const r = parse(requested);
  const c = parse(ceiling);
  if (r === null || c === null) return ceiling;
  return r <= c ? requested : ceiling;
}

/** CPU → millicores. "500m" → 500; "1" → 1000; "0.5" → 500. */
export function parseCpuMillis(q: string): number | null {
  const s = q.trim();
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

const MEMORY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  k: 1000,
};

/** Memory/storage quantity → bytes. Supports binary (Ki/Mi/Gi) and SI (K/M/G). */
export function parseMemoryBytes(q: string): number | null {
  const s = q.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/.exec(s);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2];
  if (!suffix) return value;
  const mult = MEMORY_SUFFIXES[suffix];
  return mult ? value * mult : null;
}
