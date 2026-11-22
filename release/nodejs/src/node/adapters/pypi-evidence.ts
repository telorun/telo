/**
 * The `pypi` ecosystem's evidence half.
 *
 * Its layer is the member set of the sdist the declared `[build-system]`
 * backend builds through PEP 517 `build_sdist`, in a fresh virtual environment
 * holding only `[build-system].requires` (and what the backend asks for), so
 * the backend's own include and exclude rules decide membership. The core
 * metadata a backend derives from the project — `PKG-INFO` and any
 * `*.egg-info` directory — is left out, so a backend release that rewrites it
 * moves no digest; whatever the build leaves in the project is removed.
 * Installing the requirements reads the package index pip is configured with
 * (or pip's cache). Read-back finds the sdist at the PEP 440 normalized version
 * in the simple index `registry` names and digests it by the same rule; with
 * no `registry` the layer is unverifiable and there is no destination. Import
 * edges are the links `adapters/pypi.ts` reads; `apply` moves a dependent's
 * linked requirement and every lockfile entry recording a moved version.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UnitKey } from "../../fragment.js";
import { trimTrailingSlashes } from "../../trailing-slash.js";
import {
  PYPI_LOCKFILES,
  PYPROJECT_TOML,
  isGeneratedSdistMember,
  movePypiLockContentHash,
  normalizePypiName,
  normalizePypiVersion,
  pypiBuildSystem,
  pypiDestination,
  pypiVersionProblem,
  pypiProjectIndex,
  readPypiProject,
  sdistInIndex,
  simpleIndexFiles,
  stampLinkedRequirements,
  stampPypiLockfile,
  versionsInIndex,
  type PypiBuildSystem,
  type PypiLink,
  type PypiProjectFile,
} from "../../adapters/pypi.js";
import type { AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack } from "../evidence.js";
import { digestFileSet, withoutBookkeeping, type FileSetEntry } from "../files-digest.js";
import { fetchBytes, fetchOrAbsent, RegistryError } from "../registry-fetch.js";
import { readTarGz } from "../tar.js";
import type { ReleaseWorkspace } from "../workspace.js";
import { PYPI_BUILD_SDIST_SCRIPT } from "./pypi-build-sdist.js";

/** Builds the sdist of the project in `projectDir` and returns its members,
 *  named relative to the sdist's top directory. */
export type SdistBuilder = (projectDir: string, system: PypiBuildSystem, where: string) => Promise<FileSetEntry[]>;

const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";

function joined(dir: string, relative: string): string {
  return dir === "" ? relative : `${dir}/${relative}`;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** An sdist's members beneath its one top directory. */
export function sdistMembers(bytes: Uint8Array, where: string): FileSetEntry[] {
  const entries = readTarGz(bytes, where);
  const tops = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (tops.size !== 1) throw new Error(`${where} holds ${tops.size} top-level directories, expected one.`);
  const top = [...tops][0]!;
  return entries.map((entry) => {
    if (!entry.path.startsWith(`${top}/`)) throw new Error(`${where} holds '${entry.path}' outside its '${top}/' directory.`);
    return { ...entry, path: entry.path.slice(top.length + 1) };
  });
}

/** The members a pypi layer digests: the sdist less derived metadata and the planner's bookkeeping. */
function layerMembers(members: readonly FileSetEntry[], anchorDir: string): FileSetEntry[] {
  return withoutBookkeeping(members.filter((member) => !isGeneratedSdistMember(member.path)), anchorDir);
}

function run(command: string, args: readonly string[], cwd: string, where: string, remedy = ""): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
  const shown = `\`${[command, ...args].join(" ")}\``;
  if (result.error) throw new Error(`${where}: ${shown} could not start (${result.error.message}).${remedy}`);
  if (result.status !== 0) {
    throw new Error(`${where}: ${shown} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout).trim()}${remedy}`);
  }
  return result.stdout;
}

/** What a build backend leaves behind. */
const BUILD_LEFTOVERS = (name: string): boolean =>
  name.endsWith(".egg-info") || name === "build" || name === ".pdm-build" || name === "dist";

/** Where a backend leaves them: the project's top directory, and `src` for a src layout. */
const LEFTOVER_DIRS = ["", "src"];

/** The names directly in each of {@link LEFTOVER_DIRS}, as the build found them. */
function topLevelNames(dir: string): Map<string, Set<string>> {
  return new Map(
    LEFTOVER_DIRS.map((sub) => {
      const at = path.join(dir, sub);
      return [sub, new Set(fs.existsSync(at) ? fs.readdirSync(at) : [])];
    }),
  );
}

/** Remove the build leftovers that appeared directly in those directories since
 *  `before`; returns what could not be removed, with why. */
function removeCreated(dir: string, before: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const left: string[] = [];
  for (const sub of LEFTOVER_DIRS) {
    const at = path.join(dir, sub);
    if (!fs.existsSync(at)) continue;
    for (const name of fs.readdirSync(at)) {
      if (before.get(sub)!.has(name) || !BUILD_LEFTOVERS(name)) continue;
      const full = path.join(at, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch (error) {
        left.push(`${full} (${(error as Error).message})`);
      }
    }
  }
  return left;
}

const PIP_REMEDY =
  " Installing the build requirements reads the package index pip is configured with, or pip's cache.";

/**
 * The sdist `build_sdist` produces in an isolated environment: a fresh venv,
 * `[build-system].requires` and the backend's own sdist requirements installed
 * into it, then the frontend run in the project directory.
 */
export const isolatedSdistBuilder: SdistBuilder = async (projectDir, system, where) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telorun-release-pypi-"));
  try {
    const python = process.platform === "win32" ? "python" : "python3";
    const env = path.join(scratch, "env");
    run(python, ["-I", "-m", "venv", env], scratch, where, " Install Python 3 with its venv module; the sdist is built in a fresh one.");
    const envPython = process.platform === "win32" ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python");
    const install = (requirements: readonly string[]) =>
      run(envPython, ["-I", "-m", "pip", "install", "--no-input", "--quiet", ...requirements], scratch, where, PIP_REMEDY);
    if (system.requires.length > 0) install(system.requires);
    const frontend = path.join(scratch, "pypi-build-sdist.py");
    fs.writeFileSync(frontend, PYPI_BUILD_SDIST_SCRIPT, "utf8");
    const out = path.join(scratch, "out");
    fs.mkdirSync(out);

    const before = topLevelNames(projectDir);
    let members: FileSetEntry[] | undefined;
    let failure: unknown;
    try {
      const backend = [system.backend, ...system.backendPath];
      const extra = run(envPython, ["-I", frontend, "requires", ...backend], projectDir, where).split(/\r?\n/).filter(Boolean);
      if (extra.length > 0) install(extra);
      const name = run(envPython, ["-I", frontend, "build", out, ...backend], projectDir, where).trim().split(/\r?\n/).pop() ?? "";
      const file = path.join(out, name);
      if (name === "" || !fs.existsSync(file)) throw new Error(`${where}: the build backend reported the sdist '${name}', which it did not write.`);
      members = sdistMembers(fs.readFileSync(file), `${where}'s sdist ${name}`);
    } catch (error) {
      failure = error;
    }
    const left = removeCreated(projectDir, before);
    if (failure !== undefined) throw failure;
    if (left.length > 0) throw new Error(`${where}: building the sdist left ${left.join(", ")} in the project, which could not be removed.`);
    return members!;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

export interface PypiEvidenceOptions {
  /** How an sdist is built; {@link isolatedSdistBuilder} unless given. */
  readonly buildSdist?: SdistBuilder;
}

export function pypiEvidenceWith(options: PypiEvidenceOptions = {}): EvidenceAdapter {
  const buildSdist = options.buildSdist ?? isolatedSdistBuilder;
  return {
    ecosystem: "pypi",
    async open(workspace: ReleaseWorkspace): Promise<EvidenceSession> {
      const anchors = workspace.units.flatMap((unit) =>
        unit.anchors.filter((anchor) => anchor.ecosystem === "pypi").map((anchor) => ({ unit, anchor })),
      );
      const fileOf = (dir: string) => joined(dir, PYPROJECT_TOML);
      const readProjects = (): PypiProjectFile[] =>
        anchors.map(({ unit, anchor }) => {
          const text = workspace.tree.readFile(fileOf(anchor.dir));
          if (text === undefined) throw new Error(`${unit.key}: ${fileOf(anchor.dir)} does not exist.`);
          return { unit: unit.key, dir: anchor.dir, text };
        });

      let lockfiles: string[] | undefined;
      const lockfilePaths = (): string[] => {
        lockfiles ??= ["", ...workspace.tree.directories()]
          .flatMap((dir) => PYPI_LOCKFILES.map((lockfile) => joined(dir, lockfile)))
          .filter((lock) => workspace.tree.readFile(lock) !== undefined);
        return lockfiles;
      };

      let table: Map<string, PypiLink[]> | undefined;
      const linksOf = (dir: string): PypiLink[] => {
        if (!table) {
          const projects = readProjects();
          const index = pypiProjectIndex(projects);
          const problems: string[] = [];
          const read = new Map<string, PypiLink[]>();
          for (const project of projects) {
            const found = readPypiProject(project, index);
            read.set(project.dir, found.links);
            problems.push(...found.problems);
          }
          if (problems.length > 0) throw new Error(problems.join("\n"));
          table = read;
        }
        return table.get(dir) ?? [];
      };
      const importsOf = (ref: AnchorRef): UnitKey[] => {
        const owners = new Map(anchors.map(({ unit, anchor }) => [anchor.dir, unit.key]));
        const found = new Set<UnitKey>();
        for (const link of linksOf(ref.anchor.dir)) {
          const owner = owners.get(link.target);
          if (owner !== undefined && owner !== ref.unit.key) found.add(owner);
        }
        return [...found].sort();
      };
      const registryOf = (ref: AnchorRef): string | undefined =>
        typeof ref.anchor.settings.registry === "string" ? trimTrailingSlashes(ref.anchor.settings.registry) : undefined;
      const indexPage = async (ref: AnchorRef) => {
        const registry = registryOf(ref);
        if (registry === undefined) return undefined;
        const page = `${registry}/${normalizePypiName(ref.anchor.package.name!)}/`;
        const response = await fetchOrAbsent(page, { accept: `${SIMPLE_JSON}, text/html;q=0.1` });
        if (!response) return { page, files: [] };
        const json = (response.headers.get("content-type") ?? "").includes(SIMPLE_JSON);
        return { page, files: simpleIndexFiles(await response.text(), json, page) };
      };

      return {
        async collect(ref) {
          const imports = importsOf(ref);
          if (!ref.anchor.package.contributesLayer) return { imports };
          const file = fileOf(ref.anchor.dir);
          const system = pypiBuildSystem(fs.readFileSync(path.join(workspace.root, file), "utf8"), file);
          if (!system) throw new Error(`${ref.unit.key}: ${file} declares no [build-system], so no sdist can be built.`);
          const dir = path.join(workspace.root, ref.anchor.dir);
          const members = layerMembers(await buildSdist(dir, system, ref.unit.key), ref.anchor.dir);
          return {
            layer: digestFileSet(members),
            files: members.filter((member) => fs.existsSync(path.join(dir, member.path))).map((member) => joined(ref.anchor.dir, member.path)),
            imports,
          };
        },
        async imports(ref) {
          return importsOf(ref);
        },
        destination(ref) {
          const registry = registryOf(ref);
          return registry === undefined ? undefined : pypiDestination(registry, ref.anchor.package.name!);
        },
        async readBack(ref, version, recorded): Promise<ReadBack> {
          if (registryOf(ref) === undefined) return { kind: "unverifiable", reason: "no registry names the index it is published to" };
          if (normalizePypiVersion(version) === undefined) {
            throw new Error(`${ref.unit.key}: '${version}' is not a version PEP 440 can spell, so it cannot be looked up in an index.`);
          }
          const found = (await indexPage(ref))!;
          const sdist = sdistInIndex(found.files, ref.anchor.package.name!, version, found.page);
          if (!sdist) return { kind: "absent" };
          const url = new URL(sdist.href, found.page).href;
          const bytes = await fetchBytes(url);
          if (sdist.sha256 !== undefined && sha256Hex(bytes) !== sdist.sha256) {
            throw new RegistryError(`${url} does not match the sha256 its index lists; the download is corrupt.`);
          }
          const layer = digestFileSet(layerMembers(sdistMembers(bytes, url), ref.anchor.dir));
          return { kind: "published", layer, drift: recorded !== undefined && recorded !== layer ? [`pypi/${ref.anchor.anchor}`] : [] };
        },
        async publishedVersions(ref) {
          const found = await indexPage(ref);
          return found ? versionsInIndex(found.files, ref.anchor.package.name!) : [];
        },
        async afterStamp(ref, version, plan, journal) {
          if (normalizePypiVersion(version) === undefined) {
            throw new Error(`${ref.unit.key}: ${pypiVersionProblem(version) ?? `'${version}' is not a version PEP 440 can spell`}`);
          }
          const written = new Set<string>();
          const write = (relative: string, text: string) => {
            journal(relative);
            fs.writeFileSync(path.join(workspace.root, relative), text, "utf8");
            written.add(relative);
          };
          const read = (relative: string) => workspace.tree.readFile(relative);
          const projects = readProjects();
          const index = pypiProjectIndex(projects);
          for (const project of projects) {
            if (project.dir === ref.anchor.dir) continue;
            const after = stampLinkedRequirements(project.text, project.dir, index, ref.anchor.dir, version);
            if (after === project.text) continue;
            for (const lockfile of ["poetry.lock", "pdm.lock"]) {
              const lock = joined(project.dir, lockfile);
              const text = read(lock);
              const moved = text === undefined ? undefined : movePypiLockContentHash(text, lock, project.text, after, fileOf(project.dir), sha256Hex);
              if (moved !== undefined) write(lock, moved);
            }
            write(fileOf(project.dir), after);
          }
          const target = { name: ref.anchor.package.name!, dir: ref.anchor.dir };
          for (const lock of lockfilePaths()) {
            const text = read(lock);
            const moved = text === undefined ? undefined : stampPypiLockfile(text, lock, target, version);
            if (moved !== undefined) write(lock, moved);
          }
          return [...written].sort();
        },
      };
    },
  };
}

export const pypiEvidence: EvidenceAdapter = pypiEvidenceWith();
