import * as fs from "fs/promises";
import * as path from "path";

/**
 * Writing a generated package into a `node_modules/` slot the kernel owns.
 *
 * Two callers synthesize packages: the realm (kernel-owned names a controller
 * imports, pointed at the kernel's own loaded instance) and the sibling-library
 * shims (a module's declared specifier pointed at that module's entry file).
 * Both need the same three rules — never write a slot someone else owns, write
 * atomically, and rewrite only when the content would change — so they share
 * one implementation rather than two that drift.
 */

/** Stamped into every generated `package.json`, so a later run can tell a slot
 *  this kernel wrote from a package an installer put there. */
export const SHIM_MARKER = "x-telo-generated";

/**
 * Whether the kernel may write the shim slot at `dir`.
 *
 * **Location first.** Every legitimate write site is inside the kernel's own
 * cache root — a bundle built from source lives under `<cache>/controller-src/`,
 * a published module's layers extract under `<cache>/manifests/`, and compiled
 * validators sit in `<cache>/validators/` — so a slot there is ours whatever it
 * currently holds. That is what keeps a shim written by an earlier kernel
 * version (before the marker existed, or with different contents) updatable
 * rather than mistaken for someone else's package.
 *
 * **Marker second**, for a slot outside the cache: the prebuilt-`path=` branch
 * imports out of a working copy, where `node_modules/@telorun/sql` is a package
 * manager's symlink straight into the sibling's own source tree. Reading the
 * `package.json` **through** whatever is there settles it — a symlink resolves
 * to the target's, which carries no marker — so one read covers both a link and
 * a real installed package without caring which it was.
 */
export async function isWritableShimSlot(
  dir: string,
  cacheRoot: string | undefined,
): Promise<boolean> {
  if (cacheRoot) {
    const root = path.resolve(cacheRoot) + path.sep;
    if (path.resolve(dir).startsWith(root)) return true;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return parsed[SHIM_MARKER] !== undefined;
  } catch {
    // Nothing readable there. A symlink with no package.json behind it is still
    // someone else's, so refuse that too rather than writing through it.
    try {
      return !(await fs.lstat(dir)).isSymbolicLink();
    } catch {
      return true;
    }
  }
}

/** The `package.json` of a generated package: enough for standard resolution,
 *  plus the marker. `exports` is omitted for a package whose files are reached
 *  by deep path, since an `exports` map would then have to enumerate them. */
export function shimPackageJson(
  name: string,
  kind: string,
  entry?: string,
): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      ...(entry ? { type: "module", exports: { ".": entry } } : {}),
      [SHIM_MARKER]: kind,
    },
    null,
    2,
  )}\n`;
}

/**
 * Clear a slot that an older kernel filled with a symlink, so the generated
 * package can be written as files.
 *
 * This is not tidiness. Earlier kernels resolved realm names by symlinking the
 * slot at the kernel's own package directory, and a write through such a link
 * lands in the **target** — for `@telorun/sdk` in a checkout, that is the SDK's
 * own source tree, whose `package.json` would be replaced by a generated one.
 * The slot is only reached here once it is known to be writable, so removing a
 * link in it removes something this kernel's own earlier version created.
 *
 * A real directory is left alone: it is either this kernel's generated package
 * (which `writeIfChanged` updates in place) or a package an installer owns,
 * which the slot rule has already accepted.
 */
export async function clearLinkedSlot(dir: string): Promise<void> {
  try {
    if ((await fs.lstat(dir)).isSymbolicLink()) await fs.rm(dir, { force: true });
  } catch {
    // Nothing there, or it cannot be removed — the write below reports it.
  }
}

/** Write a generated file only when its content would change, through a private
 *  temp file and an atomic rename — several kernels may populate one cache
 *  directory at once, and a reader must see a whole file or none. */
export async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(file, "utf8")) === content) return;
  } catch {
    // Absent or unreadable — write it.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${shimCounter++}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

let shimCounter = 0;
