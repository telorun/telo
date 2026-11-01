import { readFileSync } from "node:fs";

import { RunnerConfigError } from "@telorun/runner-core";
import { parse } from "yaml";

import { parseCpuMillis, parseMemoryBytes, type ContainerSizing } from "./limits.js";

const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|[KMGTPE]i?|k|[eE][+-]?[0-9]+)?$/;

/** The YAML document of the file a variable names; undefined when it is unset. */
export function readConfigFile(
  env: NodeJS.ProcessEnv,
  variable: string,
): { file: string; value: unknown } | undefined {
  const file = env[variable]?.trim();
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new RunnerConfigError(`${variable} could not be read at '${file}': ${(err as Error).message}`);
  }
  try {
    return { file, value: parse(text) };
  } catch (err) {
    throw new RunnerConfigError(`${variable} names ${file}, which is not YAML: ${(err as Error).message}`);
  }
}

/**
 * One map of a configuration file, CLOSED: a key it does not list is refused,
 * since a misspelt setting that is silently ignored is a default the operator
 * did not choose. Refusals name the key's path and the file.
 */
export class ConfigSection {
  private constructor(
    readonly file: string,
    private readonly path: string,
    private readonly values: Record<string, unknown>,
  ) {}

  /** The file's root map; an empty document is an empty map. */
  static root(file: string, value: unknown, keys: readonly string[]): ConfigSection {
    return ConfigSection.of(file, "", value, keys, `${file} must hold a map of settings.`);
  }

  private static of(
    file: string,
    path: string,
    value: unknown,
    keys: readonly string[],
    notAMap: string,
  ): ConfigSection {
    if (value === undefined || value === null) return new ConfigSection(file, path, {});
    if (typeof value !== "object" || Array.isArray(value)) throw new RunnerConfigError(notAMap);
    const section = new ConfigSection(file, path, value as Record<string, unknown>);
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        throw new RunnerConfigError(
          `${section.name(key)} is not a setting this runner reads (expected one of: ${keys.join(", ")}).`,
        );
      }
    }
    return section;
  }

  name(key: string): string {
    return `\`${this.path}${key}\` in ${this.file}`;
  }

  section(key: string, keys: readonly string[]): ConfigSection {
    return ConfigSection.of(
      this.file,
      `${this.path}${key}.`,
      this.values[key],
      keys,
      `${this.name(key)} must be a map.`,
    );
  }

  /** A setting as written, for a reader that validates it itself. */
  raw(key: string): unknown {
    return this.values[key];
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.values[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
      throw new RunnerConfigError(`${this.name(key)} must be true or false, got '${String(value)}'.`);
    }
    return value;
  }

  positiveInt(key: string, fallback: number): number {
    const value = this.values[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new RunnerConfigError(`${this.name(key)} must be a positive integer, got '${String(value)}'.`);
    }
    return value;
  }

  /** A string setting; an empty one is unset. */
  string(key: string): string | undefined {
    const value = this.values[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw new RunnerConfigError(`${this.name(key)} must be a string, got '${String(value)}'.`);
    }
    return value.trim() || undefined;
  }

  /** A Kubernetes quantity, written as a string or a number; it must be positive. */
  quantity(key: string, kind: "cpu" | "bytes"): string | undefined {
    const value = this.values[key];
    if (value === undefined || value === null) return undefined;
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : undefined;
    const amount = text === undefined || !QUANTITY.test(text) ? null : kind === "cpu" ? parseCpuMillis(text) : parseMemoryBytes(text);
    if (amount === null || amount <= 0) {
      throw new RunnerConfigError(
        `${this.name(key)} must be a positive Kubernetes quantity such as ` +
          `${kind === "cpu" ? "500m or 1" : "512Mi or 1Gi"}, got '${String(value)}'.`,
      );
    }
    return text;
  }
}

/** A container's resources when its file does not size them: no CPU limit. */
export const DEFAULT_CONTAINER_SIZING: ContainerSizing = {
  limits: { memory: "512Mi", ephemeralStorage: "1Gi" },
  requests: { cpu: "500m", memory: "512Mi" },
};

/**
 * A `resources` map: `limits` (`cpu`, `memory`, `ephemeral-storage`) and
 * `requests` (`cpu`, `memory`), each key defaulting on its own. No `cpu` limit
 * is no CPU limit, and a request above its limit is refused.
 */
export function readContainerSizing(parent: ConfigSection, key: string): ContainerSizing {
  const resources = parent.section(key, ["limits", "requests"]);
  const limits = resources.section("limits", ["cpu", "memory", "ephemeral-storage"]);
  const requests = resources.section("requests", ["cpu", "memory"]);
  const defaults = DEFAULT_CONTAINER_SIZING;
  const cpuLimit = limits.quantity("cpu", "cpu");
  const sizing: ContainerSizing = {
    limits: {
      ...(cpuLimit !== undefined ? { cpu: cpuLimit } : {}),
      memory: limits.quantity("memory", "bytes") ?? defaults.limits.memory,
      ephemeralStorage: limits.quantity("ephemeral-storage", "bytes") ?? defaults.limits.ephemeralStorage,
    },
    requests: {
      cpu: requests.quantity("cpu", "cpu") ?? defaults.requests.cpu,
      memory: requests.quantity("memory", "bytes") ?? defaults.requests.memory,
    },
  };
  const above = (request: string, limit: string | undefined, parse: (q: string) => number | null) =>
    limit !== undefined && parse(request)! > parse(limit)!;
  for (const [resource, parse] of [
    ["cpu", parseCpuMillis],
    ["memory", parseMemoryBytes],
  ] as const) {
    const request = sizing.requests[resource];
    const limit = sizing.limits[resource];
    if (above(request, limit, parse)) {
      throw new RunnerConfigError(
        `${requests.name(resource)} is ${request}, above its limit ${limit} (${limits.name(resource)}): ` +
          "a request may not exceed its limit.",
      );
    }
  }
  return sizing;
}
