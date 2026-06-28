/**
 * Host-environment access for the kernel, and the controller `process.env`
 * guardrail.
 *
 * Controllers (and their dependencies) should not bypass a declared binding by
 * reading its raw host env var: host configuration reaches a controller only
 * through `ctx.env` (the snapshot the kernel threads in) or its declared
 * `variables` / `secrets` / `ports`. To enforce that, {@link lockControllerEnv}
 * replaces the global `process.env` with a Proxy that denies reads of exactly
 * the env-var names the manifest binds — every other key (`NODE_ENV`, an SDK's
 * own `AWS_*` / `SMITHY_*` config, `~/.aws` path lookups, …) passes through
 * untouched. The kernel carries no allowlist of vendor env conventions; the
 * denied set is derived from the manifest.
 *
 * This is a **guardrail, not an isolation boundary**: controllers run in the
 * same process, so a determined one can still reach the OS environment by other
 * means (a child process, `/proc/self/environ`, re-`defineProperty`). The Proxy
 * stops casual / accidental bypass of a declared binding and makes it visible.
 *
 * The kernel itself still needs a handful of `TELO_*` / cache env vars. Those
 * reads go through {@link hostEnv}, which returns a reference captured at module
 * import — before any lock — so they keep working once the Proxy is installed.
 */

// The real environment, captured before any lock — and stored on `globalThis`
// under a process-global symbol so it is shared across *every* `@telorun/kernel`
// module instance in the process. This matters because a controller can load a
// second copy of the kernel: the `@telorun/test` suite runner imports `Kernel`
// to spawn child kernels in-process. That second copy's module body runs *after*
// the main kernel already locked `process.env`, so a plain `process.env` capture
// there would grab the (proxied) env. Reading the shared snapshot instead keeps
// every instance's `hostEnv()` — and the subprocess env it feeds — real.
//
// `lockControllerEnv` only rebinds the `process.env` *property*; it never mutates
// the original object, so this reference keeps yielding real values after a lock.
const REAL_ENV_KEY = Symbol.for("@telorun/kernel:host-env:real-env");
const LOCKED_KEY = Symbol.for("@telorun/kernel:host-env:locked");
const DENIED_KEYS_KEY = Symbol.for("@telorun/kernel:host-env:denied-keys");
const globals = globalThis as Record<symbol, unknown>;
const REAL_ENV: NodeJS.ProcessEnv = (globals[REAL_ENV_KEY] ??=
  process.env) as NodeJS.ProcessEnv;

// Process-global set of denied env-var names — the union of every booted
// kernel's declared `variables` / `secrets` / `ports` env keys. Shared on
// `globalThis` so a second in-process `@telorun/kernel` copy (the test suite
// runner spawns child kernels) and the already-installed Proxy read the same
// live set: a kernel that boots *after* the Proxy is installed still contributes
// its declared keys (see {@link lockControllerEnv}).
const DENIED_KEYS: Set<string> = (globals[DENIED_KEYS_KEY] ??= new Set<string>()) as Set<string>;

/** The real host environment. Kernel-internal use only — never handed to
 *  controllers (they get the sanctioned `ctx.env` snapshot instead). */
export function hostEnv(): NodeJS.ProcessEnv {
  return REAL_ENV;
}

/**
 * Build the guardrail Proxy over `backing`. A key in `deniedKeys` reads back
 * `undefined` — even when set — and is hidden from `in` / enumeration, with the
 * first read of each such key reported via `warn`. Every other key passes
 * through transparently (real value, no warning, visible to `in` /
 * enumeration). Writes pass through to `backing`.
 *
 * `deniedKeys` is consulted live on every trap, so keys added after the Proxy
 * is installed take effect immediately (a later kernel's bindings).
 *
 * Exported for testing; production installs it via {@link lockControllerEnv}.
 */
export function createLockedEnv(
  backing: NodeJS.ProcessEnv,
  deniedKeys: ReadonlySet<string>,
  warn: (key: string) => void,
): NodeJS.ProcessEnv {
  const warned = new Set<string>();
  const denied = (key: string | symbol): boolean =>
    typeof key === "string" && deniedKeys.has(key);

  return new Proxy(backing, {
    get(target, key) {
      if (!denied(key)) return Reflect.get(target, key);
      const name = key as string;
      if (!warned.has(name)) {
        warned.add(name);
        warn(name);
      }
      return undefined;
    },
    has(target, key) {
      return !denied(key) && Reflect.has(target, key);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => !denied(key));
    },
    getOwnPropertyDescriptor(target, key) {
      return denied(key) ? undefined : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  });
}

/**
 * Install the {@link createLockedEnv} guardrail over the global `process.env`,
 * denying reads of `deniedKeys` — the booting kernel's declared `variables` /
 * `secrets` / `ports` env-var names.
 *
 * The denied set is process-global and additive: every call unions its keys
 * into the shared {@link DENIED_KEYS} set, even after the Proxy is installed, so
 * each kernel that boots in the process contributes its bindings. Several
 * `Kernel` instances can boot in one process (the test suite runs child kernels
 * in-process), each with its own manifest; the union denies any key declared by
 * any of them — strictly safe, since a controller has no reason to read a
 * sibling app's declared key from the raw env.
 *
 * The Proxy install itself is idempotent — the flag lives on `globalThis`, so a
 * second `@telorun/kernel` instance sees the first instance's lock and does not
 * re-wrap. The property is left non-writable so a casual `process.env = {…}`
 * cannot drop the guardrail (`configurable` stays true so tooling can still
 * manage it).
 *
 * `warn` binds to the first kernel that boots in the process. In the common
 * one-kernel-per-process case that is the right sink; with in-process child
 * kernels a stray read warns to the first kernel's stderr (and dedup is
 * process-global). Acceptable — child kernels receive an explicit env and have
 * no reason to read a declared key from `process.env`.
 */
export function lockControllerEnv(
  deniedKeys: Iterable<string>,
  warn: (key: string) => void,
): void {
  for (const key of deniedKeys) DENIED_KEYS.add(key);
  if (globals[LOCKED_KEY]) return;
  globals[LOCKED_KEY] = true;

  Object.defineProperty(process, "env", {
    value: createLockedEnv(REAL_ENV, DENIED_KEYS, warn),
    writable: false,
    enumerable: true,
    configurable: true,
  });
}
