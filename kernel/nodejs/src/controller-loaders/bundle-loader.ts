import { ControllerInstance, RuntimeError } from "@telorun/sdk";
import { existsSync, readFileSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { ControllerResolveSource } from "../controller-loader.js";
import { ControllerEnvMissingError } from "./napi-loader.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bundled controller imports `@telorun/sdk` (and any realm-collapse sibling) as
 * a normal bare specifier, but it lives in a cache/extract dir with no
 * node_modules path to the SDK. Make those names resolve to the kernel's own copy
 * by symlinking them into a `node_modules/` next to the bundle — standard module
 * resolution then finds them on every runtime. (Node ESM resolve hooks aren't
 * honoured by Bun, and Bun's own plugins don't intercept runtime imports, so a
 * symlink is the one portable mechanism — verified on Node + Bun.) Authors write
 * a plain `import { Stream } from "@telorun/sdk"`; nothing special.
 *
 * Idempotent, cached per directory. On a read-only mount (k8s run) the link must
 * already exist from the extract phase; a failed create just leaves the import to
 * surface a normal module-not-found.
 */
const realmLinkedDirs = new Set<string>();
async function ensureRealmSymlinks(bundleDir: string): Promise<void> {
  if (realmLinkedDirs.has(bundleDir)) return;
  const req = createRequire(import.meta.url);
  for (const name of REALM_COLLAPSE_NAMES) {
    let pkgRoot: string | null = null;
    try {
      pkgRoot = findPackageRoot(req.resolve(name), name);
    } catch {
      // Kernel can't resolve this realm name — skip; the bundle's import then
      // fails normally rather than being silently misdirected.
    }
    if (!pkgRoot) continue;
    const linkPath = path.join(bundleDir, "node_modules", ...name.split("/"));
    // Reuse an existing link only when it already points at this kernel's copy. A
    // link a run in another environment left behind — e.g. the host symlink a
    // local run writes, then bind-mounts into a container where its target path is
    // absent — is dangling/wrong here; replace it rather than leaving the bundle's
    // import broken (`existsSync` follows the link, so it can't tell the two
    // apart). A real file/dir in the slot is left untouched.
    let stale = false;
    try {
      const stat = await fs.lstat(linkPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(linkPath);
        if (path.resolve(path.dirname(linkPath), target) === path.resolve(pkgRoot)) continue;
        stale = true;
      } else {
        continue;
      }
    } catch {
      // Nothing at linkPath — fall through to create it.
    }
    try {
      if (stale) await fs.rm(linkPath, { force: true });
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(pkgRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // EEXIST race or read-only FS — fine if it now resolves; otherwise the
      // import surfaces the resolution failure.
    }
  }
  realmLinkedDirs.add(bundleDir);
}

/**
 * Walk up from a resolved entry file to the directory whose package.json `name`
 * matches — the package root to symlink (so the symlinked package.json `exports`
 * drive per-runtime entry selection, e.g. Bun `src` vs Node `dist`).
 */
function findPackageRoot(entryFile: string, name: string): string | null {
  let dir = path.dirname(entryFile);
  for (let i = 0; i < 24; i++) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
      } catch {
        // unreadable / invalid package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Loads a `pkg:telo` controller — a controller delivered inside the module's own
 * bundle (the Telo registry artifact), not fetched from an external package
 * registry. Every PURL segment carries meaning:
 *
 *   pkg:telo / local / <format> ? path=./nodejs/x.mjs # export
 *      type     ns       name          qualifier        subpath
 *
 *  - `type=telo` — Telo-delivered (not npm/cargo).
 *  - `namespace=local` — the delivery sub-mode: bundled in the module artifact.
 *    Reserves `pkg:telo/registry/…` for a future "controller fetched from the
 *    Telo registry as its own artifact". A non-`local` namespace → env-missing
 *    here (a different mode another branch/kernel would handle).
 *  - `name=<format>` — the artifact format the loader dispatches on (`js` /
 *    `napi` / `wasm`). Bundling is the one delivery not tied to an ecosystem's
 *    runtime (npm ⇒ JS, cargo ⇒ Rust; a bundle is just files), so the format is
 *    explicit. `js` is `import()`ed directly; a format this kernel can't host →
 *    `ControllerEnvMissingError`, so `[pkg:telo/local/napi …, pkg:telo/local/js …]`
 *    (or `[pkg:telo …, pkg:npm …]`) falls through to a candidate this — or
 *    another runtime's — kernel can load.
 *  - `path` — the file in the bundle; `#export` — the named export.
 *
 * Two separate concerns for `js` bundles importing `@telorun/sdk`:
 *  - *Resolution* — the bare specifier must point at a real file. The bundle has
 *    no node_modules, so `ensureRealmSymlinks()` symlinks the realm-collapse
 *    names into a `node_modules/` next to the bundle, pointing at the kernel's
 *    own copy; standard resolution then finds them on both Node and Bun. Authors
 *    write a normal `import { Stream } from "@telorun/sdk"`; nothing special.
 *  - *Identity* — once resolved to the kernel's copy it's the same module, so
 *    `Stream`/`InvokeError` are trivially identical. (The SDK's globalThis/Symbol
 *    singletons also keep identity correct even when a publish step inlines the
 *    SDK into the bundle instead of leaving it external.)
 *
 * A missing/remote/unparseable bundle is `ControllerEnvMissingError` (fall
 * through); a bundle that loads but is malformed is a hard `ERR_CONTROLLER_INVALID`.
 */
export class BundleControllerLoader {
  async load(
    purl: string,
    baseUri: string,
  ): Promise<{ instance: ControllerInstance; source: ControllerResolveSource }> {
    let parsed: PackageURL;
    try {
      parsed = PackageURL.fromString(purl);
    } catch (err) {
      throw new ControllerEnvMissingError(
        `Unparseable pkg:telo PURL "${purl}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Delivery sub-mode lives in the namespace; this loader handles bundled
    // (`local`) controllers. Anything else (e.g. a future `registry` mode) is
    // env-missing so the candidate list falls through.
    if (parsed.namespace !== "local") {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" must use the "local" namespace (pkg:telo/local/<format>); got "${parsed.namespace ?? "(none)"}"`,
      );
    }

    // Format is the PURL name. Only `js` is hostable by the Node kernel today;
    // any other format (napi/wasm/future) is env-missing so the list falls
    // through to a sibling this — or another runtime's — kernel can load.
    const format = parsed.name;
    if (format !== "js") {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}": format "${format}" is not hostable by the Node bundle loader (supports "js" today)`,
      );
    }

    const relPath = parsed.qualifiers?.path;
    if (!relPath) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" is missing a "path" qualifier`,
      );
    }

    // Bundles are local files next to the manifest. A remote (http) baseUri
    // can't host one, so defer to the next candidate.
    if (baseUri.startsWith("http://") || baseUri.startsWith("https://")) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" requires a local manifest; baseUri is remote (${baseUri})`,
      );
    }

    const basePath = baseUri.startsWith("file://") ? fileURLToPath(baseUri) : baseUri;
    const absFile = path.resolve(path.dirname(basePath), relPath);
    if (!(await pathExists(absFile))) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller bundle not found at "${absFile}" (from "${purl}")`,
      );
    }

    // Make bare `@telorun/sdk` (etc.) resolve to the kernel's copy before
    // importing the bundle, so authors write normal imports.
    await ensureRealmSymlinks(path.dirname(absFile));

    // A broken bundle (syntax / failed import) is a real user-code failure —
    // let it propagate rather than masking it as env-missing.
    const mod = (await import(pathToFileURL(absFile).href)) as Record<string, ControllerInstance>;
    const fragment = parsed.subpath;
    // Distinguish "no such export" from "export isn't a controller" so the error
    // points at the actual problem (mirrors the napi loader's project()).
    if (fragment && !(fragment in mod)) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `Bundled controller "${purl}": module "${absFile}" has no export named "${fragment}"`,
      );
    }
    const instance = fragment ? mod[fragment] : (mod as unknown as ControllerInstance);
    if (!instance || (!instance.create && !instance.register)) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `Bundled controller "${purl}" exports neither create() nor register()` +
          (fragment ? ` at fragment "#${fragment}"` : ""),
      );
    }
    return { instance, source: "bundle" };
  }
}
