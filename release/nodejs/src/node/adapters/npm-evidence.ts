/**
 * The `npm` ecosystem's evidence half.
 *
 * Its layer is the file set the package manager's own `pack` produces — npm,
 * pnpm, yarn (classic and berry) or bun, chosen by `packageManager` or the one
 * lockfile — so it holds the `package.json` as published, with every workspace
 * range already concrete; one still holding `workspace:` or `catalog:` is
 * refused. Import edges are the siblings named in `dependencies`,
 * `peerDependencies` and `optionalDependencies` (never `devDependencies`): by a
 * `workspace:` range, and — for a manager with no workspace protocol — by a
 * plain range, which `apply` rewrites when it moves the sibling. Read-back
 * downloads the published tarball, checks `dist.integrity` for transport only,
 * and digests the unpacked set by the same rule. Both readings leave out the
 * planner's own bookkeeping (`.changes/`), which a package at the workspace
 * root would otherwise pack. The packed `package.json` is
 * digested with each dependency map in name order: a package manager writes the
 * workspace ranges it resolves in the order its resolution finished, so the same
 * package packs its manifest's maps in varying orders.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UnitKey } from "../../fragment.js";
import { PACKAGE_JSON } from "../../adapters/npm.js";
import { documentScalar, spliceScalar } from "../../version-files.js";
import type { AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack } from "../evidence.js";
import { digestFileSet, withoutBookkeeping, type FileSetEntry } from "../files-digest.js";
import { fetchBytes, fetchOrAbsent, RegistryError } from "../registry-fetch.js";
import { readTarGz } from "../tar.js";
import type { ReleaseWorkspace } from "../workspace.js";
import { detectPackageManager, packCommand, usesPlainRanges, type PackageManager } from "./package-manager.js";

const EDGE_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const UNPUBLISHABLE_RANGE = /^(workspace|catalog):/;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  publishConfig?: { registry?: string };
  [section: string]: unknown;
}

function readJson(file: string): PackageJson {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
}

function dependencies(pkg: PackageJson): [string, string, (typeof EDGE_SECTIONS)[number]][] {
  return EDGE_SECTIONS.flatMap((section) => {
    const entries = pkg[section];
    return entries && typeof entries === "object"
      ? Object.entries(entries as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([name, range]) => [name, range, section] as [string, string, (typeof EDGE_SECTIONS)[number]])
      : [];
  });
}

/** A range naming a version a release may move: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`. */
const PLAIN_RANGE = /^(\^|~|>=|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function isPlainRange(range: string): boolean {
  return /^[\^~>=<\d*x .|-]/i.test(range) && !/[:/]/.test(range);
}

export const npmEvidence: EvidenceAdapter = {
  ecosystem: "npm",
  async open(workspace: ReleaseWorkspace): Promise<EvidenceSession> {
    const owners = new Map<string, UnitKey>();
    for (const unit of workspace.units) {
      for (const anchor of unit.anchors) {
        if (anchor.ecosystem === "npm" && anchor.package.name) owners.set(anchor.package.name, unit.key);
      }
    }
    const managers = new Map<string, PackageManager>();
    const managerOf = (dir: string): PackageManager => {
      const known = managers.get(dir);
      if (known) return known;
      const found = detectPackageManager(path.join(workspace.root, dir), workspace.root);
      managers.set(dir, found);
      return found;
    };
    const manifestOf = (ref: AnchorRef) => readJson(path.join(workspace.root, ref.anchor.dir, PACKAGE_JSON));

    const importsOf = (ref: AnchorRef): UnitKey[] => {
      const plain = usesPlainRanges(managerOf(ref.anchor.dir));
      const found = new Set<UnitKey>();
      for (const [name, range] of dependencies(manifestOf(ref))) {
        const owner = owners.get(name);
        if (owner === undefined || owner === ref.unit.key) continue;
        if (range.startsWith("workspace:") || (plain && isPlainRange(range))) found.add(owner);
      }
      return [...found].sort();
    };

    const registryOf = (ref: AnchorRef): string =>
      (manifestOf(ref).publishConfig?.registry ??
        process.env.npm_config_registry ??
        process.env.NPM_CONFIG_REGISTRY ??
        DEFAULT_REGISTRY).replace(/\/+$/, "");
    const documentUrl = (ref: AnchorRef) =>
      `${registryOf(ref)}/${manifestOf(ref).name!.replace("/", "%2f")}`;

    return {
      async collect(ref) {
        const imports = importsOf(ref);
        if (!ref.anchor.package.contributesLayer) return { imports };
        const entries = withoutBookkeeping(pack(workspace.root, ref, managerOf(ref.anchor.dir)), ref.anchor.dir);
        return {
          layer: digestFileSet(canonicalManifest(entries)),
          files: entries.map((entry) => joined(ref.anchor.dir, entry.path)),
          imports,
        };
      },
      async imports(ref) {
        return importsOf(ref);
      },
      async readBack(ref, version, recorded): Promise<ReadBack> {
        const response = await fetchOrAbsent(`${documentUrl(ref)}/${encodeURIComponent(version)}`);
        if (!response) return { kind: "absent" };
        const doc = (await response.json()) as { dist?: { tarball?: string; integrity?: string; shasum?: string } };
        if (!doc.dist?.tarball) throw new RegistryError(`${documentUrl(ref)}/${version} names no dist.tarball.`);
        const bytes = await fetchBytes(doc.dist.tarball);
        checkTransport(bytes, doc.dist, doc.dist.tarball);
        const layer = digestFileSet(canonicalManifest(withoutBookkeeping(unpackTarball(bytes, doc.dist.tarball), ref.anchor.dir)));
        return { kind: "published", layer, drift: recorded !== undefined && recorded !== layer ? ["npm/" + ref.anchor.anchor] : [] };
      },
      async publishedVersions(ref) {
        const response = await fetchOrAbsent(documentUrl(ref));
        if (!response) return [];
        return Object.keys(((await response.json()) as { versions?: Record<string, unknown> }).versions ?? {});
      },
      async afterStamp(ref, version) {
        const name = ref.anchor.package.name;
        if (!name) return [];
        const written: string[] = [];
        for (const unit of workspace.units) {
          for (const anchor of unit.anchors) {
            if (anchor.ecosystem !== "npm" || unit.key === ref.unit.key) continue;
            if (!usesPlainRanges(managerOf(anchor.dir))) continue;
            const relative = joined(anchor.dir, PACKAGE_JSON);
            const file = path.join(workspace.root, relative);
            const before = fs.readFileSync(file, "utf8");
            let after = before;
            for (const [dep, range, section] of dependencies(JSON.parse(before) as PackageJson)) {
              if (dep !== name) continue;
              const match = PLAIN_RANGE.exec(range);
              if (!match) continue;
              const node = documentScalar(after, [section, dep], relative);
              if (node) after = spliceScalar(after, node, `${match[1] ?? ""}${version}`, relative);
            }
            if (after !== before) {
              fs.writeFileSync(file, after, "utf8");
              written.push(relative);
            }
          }
        }
        return written;
      },
    };
  },
};

const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** The file set with `package.json` as its layer digests it: compact JSON, each
 *  dependency map's entries in name order, every other key where it stands. */
export function canonicalManifest(entries: readonly FileSetEntry[]): FileSetEntry[] {
  return entries.map((entry) => {
    if (entry.path !== PACKAGE_JSON || !("content" in entry)) return entry;
    const manifest = JSON.parse(Buffer.from(entry.content).toString("utf8")) as Record<string, unknown>;
    for (const key of DEPENDENCY_MAPS) {
      const map = manifest[key];
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      const names = Object.keys(map).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      manifest[key] = Object.fromEntries(names.map((name) => [name, (map as Record<string, unknown>)[name]]));
    }
    return { ...entry, content: Buffer.from(JSON.stringify(manifest), "utf8") };
  });
}

function joined(dir: string, relative: string): string {
  return dir === "" ? relative : `${dir}/${relative}`;
}

/** Pack the anchor with its own manager into a scratch directory and read the
 *  file set back, refusing a manifest that would not install. */
function pack(root: string, ref: AnchorRef, manager: PackageManager): FileSetEntry[] {
  const dir = path.join(root, ref.anchor.dir);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "telorun-release-pack-"));
  try {
    const { command, args } = packCommand(manager, destination);
    const run = spawnSync(command, args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (run.error) {
      throw new Error(
        `${ref.unit.key}: \`${command} ${args.join(" ")}\` could not start (${run.error.message}). ` +
          `${command} packs this package; install it, or name another manager in 'packageManager'.`,
      );
    }
    if (run.status !== 0) {
      throw new Error(
        `${ref.unit.key}: \`${command} pack\` exited ${run.status}: ${(run.stderr || run.stdout).trim()}`,
      );
    }
    const tarballs = fs.readdirSync(destination).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`${ref.unit.key}: \`${command} pack\` wrote ${tarballs.length} tarballs, expected one.`);
    }
    const where = `${ref.unit.key}'s packed ${tarballs[0]}`;
    const entries = unpackTarball(fs.readFileSync(path.join(destination, tarballs[0]!)), where);
    const manifest = entries.find((entry) => entry.path === PACKAGE_JSON);
    if (!manifest || "link" in manifest) throw new Error(`${where} holds no package.json.`);
    const packed = JSON.parse(Buffer.from(manifest.content).toString("utf8")) as PackageJson;
    for (const [name, range, section] of dependencies(packed)) {
      if (UNPUBLISHABLE_RANGE.test(range)) {
        throw new Error(
          `${where}: package.json ${section}.${name} is still '${range}', which no registry install ` +
            `can resolve. ${manager} did not rewrite it; pack with a manager that does, or write a range.`,
        );
      }
    }
    return entries;
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

/** A tarball's file set, beneath its one top-level directory (`package/`). */
function unpackTarball(bytes: Uint8Array, where: string): FileSetEntry[] {
  const entries = readTarGz(bytes, where);
  const tops = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (tops.size !== 1) throw new Error(`${where} holds ${tops.size} top-level directories, expected one.`);
  const top = [...tops][0]!;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(top.length + 1) }));
}

function checkTransport(bytes: Uint8Array, dist: { integrity?: string; shasum?: string }, url: string): void {
  if (dist.integrity) {
    const [algorithm, expected] = dist.integrity.split(/-(.*)/s);
    const actual = createHash(algorithm!).update(bytes).digest("base64");
    if (actual !== expected) throw new RegistryError(`${url} does not match its dist.integrity; the download is corrupt.`);
    return;
  }
  if (dist.shasum && createHash("sha1").update(bytes).digest("hex") !== dist.shasum) {
    throw new RegistryError(`${url} does not match its dist.shasum; the download is corrupt.`);
  }
}
