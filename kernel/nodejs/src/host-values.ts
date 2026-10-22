import { PUBLIC_URL_HOST_VALUES, STATE_DIR_HOST_VALUE } from "@telorun/analyzer";

/**
 * The HOST VALUES — what a host sets for the kernel to answer kernel-declared
 * need types from. They are the kernel's to read: hidden from every controller,
 * and never inherited by a started child application, which is a root of its
 * own. Exactly these names, never the whole `TELO_HOST_*` prefix — the
 * container-engine values must still reach a child.
 */
export const KERNEL_HOST_VALUES: readonly string[] = [...PUBLIC_URL_HOST_VALUES, STATE_DIR_HOST_VALUE];

/** The environment a started child application inherits: without the host
 *  values, which answer the parent's needs and never the child's. */
export function withoutHostValues(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!KERNEL_HOST_VALUES.some((name) => name in env)) return env;
  const out = { ...env };
  for (const name of KERNEL_HOST_VALUES) delete out[name];
  return out;
}
