/**
 * The `cargo` ecosystem's evidence half.
 *
 * Its layer is the file set `cargo package --list` names, read from disk;
 * `Cargo.toml` is the authored manifest (cargo ships it as `Cargo.toml.orig`
 * beside a normalized copy), and what cargo generates — `.cargo_vcs_info.json`
 * and a `Cargo.lock` pruned to the crate — is left out, since no file in the
 * tree holds it. A crate with a linked-artifact target has `Cargo.lock` in its
 * layer instead as its external closure (`adapters/cargo-closure.ts`), read
 * from `cargo metadata` and never from disk, so a lockfile-only bump releases
 * the binaries that link it. Read-back unpacks the `.crate` crates.io serves
 * under the same rule, the closure recomputed from its own `Cargo.lock`, so
 * the two digests compare. Import edges are path dependencies — normal, build
 * and target-specific, never dev — read from `cargo metadata`. A crate with
 * `publish = false` has a layer and no read-back. An anchor is one crate and
 * covers nothing beneath it. When a crate moves, every cargo anchor naming it
 * by path with a version requirement has that requirement moved with it, or
 * the dependent would no longer resolve against the new version.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CARGO_LOCK, CARGO_TOML, stampPathDependencyRequirements } from "../../adapters/cargo.js";
import { closureFromLock, closureFromMetadata, linksArtifact } from "../../adapters/cargo-closure.js";
import type { UnitKey } from "../../fragment.js";
import type { AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack } from "../evidence.js";
import { digestFileSet, isBookkeeping, readFileSetEntry, withoutBookkeeping, type FileSetEntry } from "../files-digest.js";
import { fetchBytes, fetchOrAbsent } from "../registry-fetch.js";
import { readTarGz, stripPrefix } from "../tar.js";
import type { ReleaseWorkspace } from "../workspace.js";

/** Files cargo writes into a package that no file in the tree reproduces: the
 *  VCS record, the authored manifest's copy, and a `Cargo.lock` pruned to the
 *  crate's own dependencies. */
const GENERATED = new Set([".cargo_vcs_info.json", "Cargo.toml.orig", "Cargo.lock"]);
const CRATES_IO = "https://crates.io/api/v1/crates";

interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly manifest_path: string;
  /** `license-file` and `readme` as the manifest writes them, relative to it. */
  readonly license_file?: string | null;
  readonly readme?: string | null;
  readonly publish: readonly string[] | null;
  readonly dependencies: readonly { readonly path?: string; readonly kind: string | null }[];
  readonly targets: readonly { readonly kind: readonly string[] }[];
}

interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspace_members: readonly string[];
}

function cargo(args: string[], cwd: string, what: string, remedy = ""): string {
  const run = spawnSync("cargo", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw new Error(`${what}: cargo could not start (${run.error.message}). Install the Rust toolchain.`);
  if (run.status !== 0) throw new Error(`${what}: \`cargo ${args.join(" ")}\` exited ${run.status}: ${run.stderr.trim()}${remedy}`);
  return run.stdout;
}

/** The resolve is read offline across every platform, so each platform's crates must be on disk. */
const CLOSURE_REMEDY = " Fetch every platform's crates first with `cargo fetch --locked`.";

export const cargoEvidence: EvidenceAdapter = {
  ecosystem: "cargo",
  async open(workspace: ReleaseWorkspace): Promise<EvidenceSession> {
    const owners = new Map<string, UnitKey>();
    for (const unit of workspace.units) {
      for (const anchor of unit.anchors) {
        if (anchor.ecosystem === "cargo") owners.set(path.resolve(workspace.root, anchor.dir), unit.key);
      }
    }
    const metadata = new Map<string, { pkg: CargoPackage; members: string[] }>();
    const read = (ref: AnchorRef) => {
      const manifest = path.resolve(workspace.root, ref.anchor.dir, CARGO_TOML);
      const known = metadata.get(manifest);
      if (known) return known;
      const answer = JSON.parse(
        cargo(["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest], workspace.root, ref.unit.key),
      ) as CargoMetadata;
      const members = answer.packages.filter((pkg) => answer.workspace_members.includes(pkg.id)).map((pkg) => pkg.name);
      for (const pkg of answer.packages) metadata.set(path.resolve(pkg.manifest_path), { pkg, members });
      const found = metadata.get(manifest);
      if (!found) throw new Error(`${ref.unit.key}: cargo metadata does not list the crate at ${manifest}.`);
      return found;
    };
    const packageOf = (ref: AnchorRef): CargoPackage => read(ref).pkg;
    const resolved = new Map<string, unknown>();
    const closureOf = (ref: AnchorRef): string => {
      const manifest = path.resolve(workspace.root, ref.anchor.dir, CARGO_TOML);
      let answer = resolved.get(manifest);
      if (answer === undefined) {
        const args = ["metadata", "--locked", "--offline", "--all-features", "--format-version", "1", "--manifest-path", manifest];
        answer = JSON.parse(cargo(args, workspace.root, ref.unit.key, CLOSURE_REMEDY));
        const listed = answer as CargoMetadata;
        const members = new Set(listed.workspace_members);
        for (const pkg of listed.packages) if (members.has(pkg.id)) resolved.set(path.resolve(pkg.manifest_path), answer);
      }
      return closureFromMetadata(answer, packageOf(ref).id);
    };
    const importsOf = (ref: AnchorRef): UnitKey[] => {
      const found = new Set<UnitKey>();
      for (const dependency of packageOf(ref).dependencies) {
        if (dependency.kind === "dev" || !dependency.path) continue;
        const owner = owners.get(path.resolve(dependency.path));
        if (owner !== undefined && owner !== ref.unit.key) found.add(owner);
      }
      return [...found].sort();
    };
    const published = (ref: AnchorRef) => {
      const publish = packageOf(ref).publish;
      return publish === null || publish.length > 0;
    };

    return {
      async collect(ref) {
        const pkg = packageOf(ref);
        const packaged = packagedFiles(workspace, ref, pkg);
        const entries = packaged.map((entry) => entry.entry);
        if (linksArtifact(pkg.targets)) entries.push({ path: CARGO_LOCK, content: Buffer.from(closureOf(ref), "utf8") });
        return {
          layer: digestFileSet(entries),
          files: packaged.map((entry) => entry.source),
          imports: importsOf(ref),
        };
      },
      async imports(ref) {
        return importsOf(ref);
      },
      async readBack(ref, version, recorded): Promise<ReadBack> {
        if (!published(ref)) return { kind: "unverifiable", reason: "publish = false, so nothing is published to read back" };
        const { pkg, members } = read(ref);
        const name = pkg.name;
        const meta = await fetchOrAbsent(`${CRATES_IO}/${name}/${version}`);
        if (!meta) return { kind: "absent" };
        const bytes = await fetchBytes(`${CRATES_IO}/${name}/${version}/download`);
        const closure = linksArtifact(pkg.targets) ? { name, version, members } : undefined;
        const layer = digestFileSet(withoutBookkeeping(publishedFiles(bytes, `${name}-${version}`, closure), ref.anchor.dir));
        return { kind: "published", layer, drift: recorded !== undefined && recorded !== layer ? [`cargo/${ref.anchor.anchor}`] : [] };
      },
      async afterStamp(ref, version) {
        const written: string[] = [];
        for (const unit of workspace.units) {
          for (const anchor of unit.anchors) {
            if (anchor.ecosystem !== "cargo" || anchor.dir === ref.anchor.dir) continue;
            const relative = joined(anchor.dir, CARGO_TOML);
            const file = path.join(workspace.root, relative);
            const before = fs.readFileSync(file, "utf8");
            const after = stampPathDependencyRequirements(before, anchor.dir, ref.anchor.dir, version);
            if (after === before) continue;
            fs.writeFileSync(file, after, "utf8");
            written.push(relative);
          }
        }
        return written;
      },
      async publishedVersions(ref) {
        const response = await fetchOrAbsent(`${CRATES_IO}/${packageOf(ref).name}/versions`);
        if (!response) return [];
        return ((await response.json()) as { versions?: { num: string }[] }).versions?.map((v) => v.num) ?? [];
      },
    };
  },
};

/**
 * The files `cargo package --list` names, read where they are: a `license-file` or
 * `readme` outside the crate is packaged at the crate's root under its own name, so
 * a listed name absent from the crate is read from the path the manifest gives.
 */
function packagedFiles(workspace: ReleaseWorkspace, ref: AnchorRef, pkg: CargoPackage): { entry: FileSetEntry; source: string }[] {
  const dir = path.join(workspace.root, ref.anchor.dir);
  const listed = cargo(["package", "--list", "--allow-dirty", "--manifest-path", path.join(dir, CARGO_TOML)], dir, ref.unit.key)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: { entry: FileSetEntry; source: string }[] = [];
  for (const file of listed) {
    if (GENERATED.has(file) || isBookkeeping(joined(ref.anchor.dir, file))) continue;
    if (fs.existsSync(path.join(dir, file))) {
      out.push({ entry: readFileSetEntry(dir, file), source: joined(ref.anchor.dir, file) });
      continue;
    }
    const outside = [pkg.license_file, pkg.readme].find(
      (written): written is string => typeof written === "string" && path.posix.basename(written.replace(/\\/g, "/")) === file,
    );
    if (outside && fs.existsSync(path.resolve(dir, outside))) {
      const source = path.relative(workspace.root, path.resolve(dir, outside)).split(path.sep).join("/");
      out.push({ entry: readFileSetEntry(workspace.root, source, file), source });
      continue;
    }
    throw new Error(`${ref.unit.key}: \`cargo package --list\` names '${file}', which is not on disk.`);
  }
  return out;
}

/**
 * A `.crate`'s files under the tree's rule: the authored manifest as
 * `Cargo.toml`, nothing cargo generated, and — for a crate linking an
 * artifact — the closure its own `Cargo.lock` and packaged manifest give.
 */
function publishedFiles(
  bytes: Uint8Array,
  prefix: string,
  closure: { name: string; version: string; members: readonly string[] } | undefined,
): FileSetEntry[] {
  const at = `${prefix}.crate`;
  const entries = stripPrefix(readTarGz(bytes, at), prefix, at);
  const orig = entries.find((entry) => entry.path === "Cargo.toml.orig");
  const kept: FileSetEntry[] = entries
    .filter((entry) => !GENERATED.has(entry.path) && (!orig || entry.path !== CARGO_TOML))
    .concat(orig ? [{ ...orig, path: CARGO_TOML }] : []);
  if (!closure) return kept;
  const text = (file: string): string => {
    const entry = entries.find((candidate) => candidate.path === file);
    if (!entry || !("content" in entry)) throw new Error(`${at}: holds no ${file}, so the closure the crate links cannot be read.`);
    return Buffer.from(entry.content).toString("utf8");
  };
  const lock = closureFromLock(text(CARGO_LOCK), text(CARGO_TOML), closure, closure.members, `${at}/${CARGO_LOCK}`);
  return kept.concat([{ path: CARGO_LOCK, content: Buffer.from(lock, "utf8") }]);
}

function joined(dir: string, relative: string): string {
  return dir === "" ? relative : `${dir}/${relative}`;
}
