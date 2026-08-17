import type { HostVersions } from "@telorun/analyzer";

/**
 * The versions this Node host can speak for, for a module's `requires.host.*`
 * ranges.
 *
 * **One supplier, so the sites cannot drift.** Every Node-side entry into
 * `StaticAnalyzer.analyze` — the kernel's load path, its `check` seam and the
 * CLI's `check` command — must report the same host, or the same manifest would
 * be accepted by one and rejected by another. Reading `process.versions` at each
 * call site is three chances to forget one, and forgetting is silent: the axis is
 * simply skipped and the requirement quietly stops being enforced, which is the
 * failure class declared requirements exist to remove.
 *
 * It lives in the kernel rather than the analyzer because the analyzer is
 * browser-safe and has no `process`. That split is the point: the analyzer owns
 * reading and ordering the axes, and only the comparison target is per-runtime.
 *
 * `process.versions.node` is absent on no Node or Bun release this runs on, but
 * an absent entry is skipped rather than guessed, so a host that cannot name
 * itself declines to enforce rather than inventing a verdict.
 */
export function nodeHostVersions(): HostVersions {
  const node = process.versions?.node;
  return typeof node === "string" && node ? { node } : {};
}
