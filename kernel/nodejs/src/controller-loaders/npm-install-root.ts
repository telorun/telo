import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { hostPlatformTarget } from "../bundle/module-artifact.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";

/**
 * Which npm install root a runner uses, and why that is keyed on the realm
 * dependency's RELATIVE path rather than on the manifest.
 *
 * The root's `package.json` records the kernel-provided realm package as a
 * `file:` dependency pointing at the running CLI's own copy, and npm rewrites
 * that into a path RELATIVE to the root — in `package.json`, in
 * `package-lock.json`, and as the target of the symlink it materializes under
 * `node_modules`. Once the cache is anchored at the workspace, a second runner
 * meets that tree and reads a path that resolves elsewhere or nowhere: an
 * `EMISSINGTARGET` install failure, or a dangling link whose failure surfaces
 * later at the controller's import. The normal shape is one checkout
 * bind-mounted into a container (`/home/me/app` on the host, `/app` inside it)
 * while the developer also runs telo on the host.
 *
 * So the key is exactly that relative path, plus the host platform. It is not a
 * proxy for the problem — it IS the string npm will write into the tree, so two
 * runners share a root precisely when everything npm records there means the
 * same thing on both sides, and never otherwise:
 *
 * - a different CLI installation (host vs container) → different path → apart;
 * - the same CLI, workspace mounted at another DEPTH (`/w` vs `/deep/a/b/c/w`)
 *   → a different number of `..` segments → apart;
 * - the same CLI, workspace copied to another directory at the same depth
 *   (`WORKDIR /build` … `COPY --from=build /build /srv`) → identical path → one
 *   root, so an image finds the tree `telo install` warmed for it;
 * - a different architecture or libc → apart, since a native controller build
 *   is not interchangeable.
 *
 * Keying on the ENTRY MANIFEST instead was the first attempt, and it cost more
 * than it bought: it did separate host from container, but it also gave every
 * manifest in a workspace its own tree — 60 of them after one `pnpm run test`
 * here — which is the one-repo-one-cache property the workspace-anchored cache
 * exists for. It also could not tell a `/build` → `/srv` copy from a bind
 * mount, so it needed a content-keyed alias plus a validity check on top:
 * machinery this key does not need, because a root it selects is usable by
 * construction.
 */
export async function resolveInstallRoot(
  npmBase: string,
  realmPackageRoot: RealmPackageResolver,
): Promise<string> {
  return path.join(npmBase, await installRootKey(npmBase, realmPackageRoot));
}

/** How this kernel resolves a realm package to its own copy. Passed in rather
 *  than imported: realm resolution belongs to the loader, whose module graph
 *  this one sits underneath, and a parameter is what lets a test present a
 *  different CLI's resolution. */
export type RealmPackageResolver = (name: string) => Promise<string | null>;

/**
 * The directory name for one (runner, filesystem view, platform) triple.
 *
 * Every field is written even when it is empty — an unresolvable realm package,
 * an undetermined libc — so an absent value and a value that happens to be the
 * empty string cannot produce one key.
 */
async function installRootKey(
  npmBase: string,
  realmPackageRoot: RealmPackageResolver,
): Promise<string> {
  const host = hostPlatformTarget();
  const fields = [
    ...(await realmRelativePaths(npmBase, realmPackageRoot)),
    host.os ?? "",
    host.arch ?? "",
    host.libc ?? "",
  ];
  return createHash("sha256").update(fields.join("\0")).digest("hex").slice(0, 32);
}

/**
 * Each realm package as npm will record it: relative to the root, in the
 * declared order so the key does not move with iteration order.
 *
 * Measured from the BASE rather than the root, since the root's name is what
 * this feeds — the two differ by one constant segment. A name this kernel
 * cannot resolve is recorded as empty rather than skipped, mirroring the
 * installer, which omits such a dependency from the root instead of failing;
 * runners that differ only in whether they could resolve it genuinely write
 * different trees.
 */
async function realmRelativePaths(
  npmBase: string,
  realmPackageRoot: RealmPackageResolver,
): Promise<string[]> {
  const out: string[] = [];
  for (const name of REALM_COLLAPSE_NAMES) {
    const resolved = await realmPackageRoot(name);
    out.push(`${name}=${resolved ? path.relative(npmBase, resolved) : ""}`);
  }
  return out;
}

/** Names what a root was keyed from, for whoever is working out which runner
 *  wrote which tree. Read by nothing. */
export const INSTALL_ROOT_MARKER = ".telo-install-root.json";

/**
 * Write the marker once, when the root is created. Rewriting it on later
 * installs would only restate what the directory name already fixes, and the
 * value it carries is the key's own inputs — never an entry manifest, since one
 * root serves every manifest in the workspace and naming one would name a
 * coincidence.
 */
export async function writeInstallRootMarker(
  root: string,
  npmBase: string,
  realmPackageRoot: RealmPackageResolver,
): Promise<void> {
  const target = path.join(root, INSTALL_ROOT_MARKER);
  try {
    await fs.access(target);
    return;
  } catch {
    // Absent — this is the run that created the root.
  }
  const marker = {
    realm: await realmRelativePaths(npmBase, realmPackageRoot),
    ...hostPlatformTarget(),
  };
  // A marker nothing reads must never fail an install.
  await fs.writeFile(target, JSON.stringify(marker, null, 2) + "\n").catch(() => {});
}
