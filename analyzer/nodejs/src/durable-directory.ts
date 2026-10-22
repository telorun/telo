import { needParametersWithDefaults, type NeedTypeShape } from "./need-type.js";

/**
 * DURABLE DIRECTORIES — the kernel-declared need type an application asks for
 * persistent storage on disk with, and the one reader of what its parameters
 * mean. Shared by `telo check` (the need table's forwarding refusals) and the
 * kernel (answering it from the host's state directory), so the two cannot read
 * a size or an access mode differently.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const DURABLE_DIRECTORY_TYPE = "Telo.DurableDirectory";

/** The host value a host sets to answer every durable directory from one
 *  directory it owns: each need's is `<state dir>/needs/<need path>`. */
export const STATE_DIR_HOST_VALUE = "TELO_HOST_STATE_DIR";

export type DirectoryAccess = "single-writer" | "shared";

export interface DurableDirectoryParameters {
  /** As written (`5Gi`), or the type's default. */
  size: string;
  /** In bytes, or undefined when `size` is not one the type accepts. */
  bytes?: bigint;
  access: DirectoryAccess;
}

const UNIT_SHIFT = { Mi: 20n, Gi: 30n, Ti: 40n } as const;

/** A size in bytes: a whole number followed by `Mi`, `Gi` or `Ti`. */
export function directorySizeBytes(size: string): bigint | undefined {
  const match = /^([1-9][0-9]*)(Mi|Gi|Ti)$/.exec(size);
  return match ? BigInt(match[1]!) << UNIT_SHIFT[match[2] as keyof typeof UNIT_SHIFT] : undefined;
}

/** A durable directory need's parameters, the type's defaults filled in. */
export function durableDirectoryParameters(
  shape: NeedTypeShape | undefined,
  parameters: unknown,
): DurableDirectoryParameters {
  const filled = needParametersWithDefaults(shape, parameters);
  const record = filled && typeof filled === "object" && !Array.isArray(filled) ? (filled as Record<string, unknown>) : {};
  const size = typeof record.size === "string" ? record.size : "";
  const bytes = directorySizeBytes(size);
  return {
    size,
    ...(bytes !== undefined ? { bytes } : {}),
    access: record.access === "shared" ? "shared" : "single-writer",
  };
}

/**
 * Why a durable directory need cannot be supplied whole by another — the one it
 * is forwarded from — or undefined when it can: a `shared` directory breaks a
 * `single-writer` need's assumption, and a smaller one is less than it asked for.
 */
export function directoryForwardRefusal(
  supplied: DurableDirectoryParameters,
  wanted: DurableDirectoryParameters,
): string | undefined {
  if (supplied.access === "shared" && wanted.access === "single-writer") {
    return (
      `it asks for 'access: single-writer', relying on at most one running instance having the ` +
      `directory, and the need supplying it is 'shared'`
    );
  }
  if (supplied.bytes !== undefined && wanted.bytes !== undefined && supplied.bytes < wanted.bytes) {
    return `it asks for 'size: ${wanted.size}', and the need supplying it asks for only '${supplied.size}'`;
  }
  return undefined;
}
