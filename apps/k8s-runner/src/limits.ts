/**
 * Resource limits the runner will ever grant one container. These are HARD
 * CEILINGS, not defaults a request can exceed: the effective value is
 * `min(requested, ceiling)` (clamp-down only). For a bare runner serving an
 * anonymous tier directly, the ceiling IS the policy. No `cpu` is no CPU limit.
 */
export interface LimitCeilings {
  /** Kubernetes CPU quantity, e.g. "500m". */
  cpu?: string;
  /** Kubernetes memory quantity, e.g. "512Mi". */
  memory: string;
  /** Per-container ephemeral-storage limit, e.g. "1Gi". */
  ephemeralStorage: string;
}

/** What the scheduler reserves for a container; never above its limit. */
export interface ResourceRequests {
  cpu: string;
  memory: string;
}

/** One container's configured resources: its ceilings and its requests. */
export interface ContainerSizing {
  limits: LimitCeilings;
  requests: ResourceRequests;
}

/**
 * Effective per-container resource limits. Requests may ask for LESS than the
 * ceiling but never MORE — `min(requested, ceiling)`. Without a control plane
 * the editor talks to the runner directly, so a raisable limit would void the
 * cap; clamp-down-only is the load-bearing invariant.
 */
export interface ResolvedLimits {
  cpu?: string;
  memory: string;
  ephemeralStorage: string;
}

export interface RequestedLimits {
  cpu?: string;
  memory?: string;
  ephemeralStorage?: string;
}

export interface ResolvedResources {
  limits: ResolvedLimits;
  requests: ResourceRequests;
}

export function clampLimits(
  ceilings: LimitCeilings,
  requested: RequestedLimits | undefined,
): ResolvedLimits {
  const cpu =
    ceilings.cpu === undefined
      ? uncappedCpu(requested?.cpu)
      : clampQuantity(ceilings.cpu, requested?.cpu, parseCpuMillis);
  return {
    ...(cpu !== undefined ? { cpu } : {}),
    memory: clampQuantity(ceilings.memory, requested?.memory, parseMemoryBytes),
    ephemeralStorage: clampQuantity(
      ceilings.ephemeralStorage,
      requested?.ephemeralStorage,
      parseMemoryBytes,
    ),
  };
}

/** A container's limits clamped as `clampLimits` does, and its requests held
 *  at or below them, so a lowered limit never leaves a request above it. */
export function resolveResources(
  sizing: ContainerSizing,
  requested?: RequestedLimits,
): ResolvedResources {
  const limits = clampLimits(sizing.limits, requested);
  return {
    limits,
    requests: {
      cpu:
        limits.cpu === undefined
          ? sizing.requests.cpu
          : lowerQuantity(sizing.requests.cpu, limits.cpu, parseCpuMillis),
      memory: lowerQuantity(sizing.requests.memory, limits.memory, parseMemoryBytes),
    },
  };
}

/** A pod container's `resources`. */
export function podResources(resources: ResolvedResources): {
  limits: Record<string, string>;
  requests: Record<string, string>;
} {
  const { limits, requests } = resources;
  return {
    limits: {
      ...(limits.cpu !== undefined ? { cpu: limits.cpu } : {}),
      memory: limits.memory,
      "ephemeral-storage": limits.ephemeralStorage,
    },
    requests: { cpu: requests.cpu, memory: requests.memory },
  };
}

/** With no ceiling a requested cpu passes as it is, when it parses. */
function uncappedCpu(requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  return parseCpuMillis(requested) === null ? undefined : requested;
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

function lowerQuantity(a: string, b: string, parse: (q: string) => number | null): string {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return a;
  return x <= y ? a : b;
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
