/**
 * The `pypi` ecosystem's pure half: an anchor holding a `pyproject.toml` with a
 * `[project]` table carrying `name` is one Python distribution. Its version is
 * `project.version`; one listed in `project.dynamic` is no static version, and
 * a `pyproject.toml` with no `[build-system]` builds nothing, so contributes no
 * layer. Edges are runtime requirements whose source is a sibling's directory,
 * named through `[tool.uv.sources]`, `[tool.poetry.dependencies]` or a `file:`
 * reference rooted at the project (PDM, Hatch). This file also holds what apply
 * rewrites — a linked requirement's specifier, a lockfile's entry and content
 * hash — and how a published sdist is found in a simple index, all over text.
 */

import type { EcosystemAdapter, RecognizedPackage } from "../adapter.js";
import { isUnitVersion } from "../bump-level.js";
import type { UnitKey } from "../fragment.js";
import { trimTrailingSlashes } from "../trailing-slash.js";
import { VersionFileError, pyprojectTomlHandler, spliceText, tomlString } from "../version-files.js";
import {
  TomlError,
  readTomlDocument,
  respellTomlString,
  tomlAt,
  type TomlString,
  type TomlTable,
  type TomlValue,
} from "./toml-document.js";

export const PYPROJECT_TOML = "pyproject.toml";
/** The lockfiles that record a path project's version. */
export const PYPI_LOCKFILES: readonly string[] = ["uv.lock", "poetry.lock", "pdm.lock"];

// ---------------------------------------------------------------------------
// Names and versions
// ---------------------------------------------------------------------------

/** A distribution name as PEP 503 compares it. */
export function normalizePypiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

const PEP440 =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

interface Pep440 {
  readonly epoch: string;
  readonly release: readonly string[];
  readonly rest: string;
}

function parsePep440(version: string): Pep440 | undefined {
  const m = PEP440.exec(version.trim());
  if (!m) return undefined;
  const int = (text: string | undefined) => String(BigInt(text ?? "0"));
  const pre = m[3] ? `${{ alpha: "a", a: "a", beta: "b", b: "b" }[m[3].toLowerCase()] ?? "rc"}${int(m[4])}` : "";
  const post = m[5] !== undefined ? `.post${int(m[5])}` : m[6] ? `.post${int(m[7])}` : "";
  const dev = m[8] ? `.dev${int(m[9])}` : "";
  const local = m[10] ? `+${m[10].toLowerCase().split(/[-_.]/).map((part) => (/^\d+$/.test(part) ? int(part) : part)).join(".")}` : "";
  return { epoch: m[1] && BigInt(m[1]) !== 0n ? `${int(m[1])}!` : "", release: m[2]!.split(".").map(int), rest: pre + post + dev + local };
}

/** A version in PEP 440 normalized form (`1.0.0-rc.1` → `1.0.0rc1`), or
 *  `undefined` when PEP 440 cannot spell it. */
export function normalizePypiVersion(version: string): string | undefined {
  const parsed = parsePep440(version);
  return parsed && `${parsed.epoch}${parsed.release.join(".")}${parsed.rest}`;
}

/** Two versions PEP 440 holds equal compare equal here (`1.0` and `1.0.0`). */
function versionKey(version: string): string | undefined {
  const parsed = parsePep440(version);
  if (!parsed) return undefined;
  const release = [...parsed.release];
  while (release.length > 1 && release[release.length - 1] === "0") release.pop();
  return `${parsed.epoch}${release.join(".")}${parsed.rest}`;
}

/** Why `version` cannot be planned or published, or `undefined` when it can. */
export function pypiVersionProblem(version: string): string | undefined {
  if (!isUnitVersion(version)) {
    return `'${version}' is not a version a release can be planned from: write it as major.minor.patch (1.2.3), or a candidate of one (1.2.3-rc.1)`;
  }
  if (normalizePypiVersion(version) === undefined) {
    return `'${version}' is not a version PEP 440 can spell: a candidate's identifier must be one of a, alpha, b, beta, c, rc, pre, preview, dev or post`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

function readDocument(text: string, where: string): TomlTable | undefined {
  try {
    return readTomlDocument(text, where);
  } catch (error) {
    if (error instanceof TomlError) return undefined;
    throw error;
  }
}

function stringAt(from: TomlTable, path: readonly string[]): string | undefined {
  const value = tomlAt(from, path);
  return value?.kind === "string" ? value.value : undefined;
}

function strings(value: TomlValue | undefined): string[] {
  return value?.kind === "array" ? value.items.flatMap((item) => (item.kind === "string" ? [item.value] : [])) : [];
}

/** The tool that derives a dynamic version from git, when one does. */
function vcsVersionTool(doc: TomlTable): string | undefined {
  const requires = strings(tomlAt(doc, ["build-system", "requires"])).map((r) => normalizePypiName(requirementName(r) ?? ""));
  if (tomlAt(doc, ["tool", "setuptools_scm"]) !== undefined) return "setuptools-scm";
  if (requires.includes("setuptools-scm") && tomlAt(doc, ["tool", "setuptools", "dynamic", "version"]) === undefined) return "setuptools-scm";
  if (stringAt(doc, ["tool", "hatch", "version", "source"]) === "vcs") return "hatch-vcs";
  if (stringAt(doc, ["tool", "pdm", "version", "source"]) === "scm") return "pdm-backend's scm source";
  const dynamicVersioning = tomlAt(doc, ["tool", "poetry-dynamic-versioning", "enable"]);
  if (dynamicVersioning?.kind === "boolean" && dynamicVersioning.value) return "poetry-dynamic-versioning";
  return undefined;
}

export const pypiAdapter: EcosystemAdapter = {
  ecosystem: "pypi",
  anchorDescription: "a directory holding a pyproject.toml with a [project] table carrying name",
  keys: {
    registry: {
      type: "string",
      description:
        "Simple-API index base URL the distribution is published to and read back from, as `<registry>/<normalized name>`. Omitted: no read-back, and no destination.",
      examples: ["https://pypi.org/simple"],
    },
  },
  versionFile: { file: PYPROJECT_TOML },
  recognize(probe): RecognizedPackage | undefined {
    const text = probe.readFile(PYPROJECT_TOML);
    if (text === undefined) return undefined;
    const where = `${probe.dir || "."}/${PYPROJECT_TOML}`;
    const doc = readDocument(text, where);
    // A file that does not parse is still the anchor its scanned name says;
    // the evidence half refuses it with the parse error.
    if (!doc) {
      const name = tomlString(text, ["project", "name"], where)?.value;
      return name === undefined ? undefined : { name, contributesLayer: true };
    }
    const name = stringAt(doc, ["project", "name"]);
    if (name === undefined) return undefined;
    const at = `pypi at \`${probe.anchor}\``;
    const layer: Pick<RecognizedPackage, "contributesLayer" | "noLayerReason"> =
      tomlAt(doc, ["build-system"]) === undefined
        ? { contributesLayer: false, noLayerReason: `${at} declares no \`[build-system]\`` }
        : { contributesLayer: true };
    const noStaticVersion = (() => {
      if (strings(tomlAt(doc, ["project", "dynamic"])).includes("version")) {
        const tool = vcsVersionTool(doc);
        return tool
          ? `${at} lists \`version\` in \`project.dynamic\` and derives it from git through ${tool}, which no release can plan; make its build backend read the version from a file instead`
          : `${at} lists \`version\` in \`project.dynamic\``;
      }
      if (tomlAt(doc, ["project", "version"]) === undefined) return `${at} sets no \`project.version\``;
      if (tomlString(text, ["project", "version"], where) === undefined) {
        return `${at} writes \`project.version\` in a form that cannot be rewritten in place; write it as version = "<version>" in the [project] table`;
      }
      return undefined;
    })();
    return { name, ...layer, ...(noStaticVersion !== undefined ? { noStaticVersion } : {}) };
  },
  versionFileHandlers: [pyprojectTomlHandler],
};

// ---------------------------------------------------------------------------
// The build system
// ---------------------------------------------------------------------------

export interface PypiBuildSystem {
  readonly requires: readonly string[];
  readonly backend: string;
  readonly backendPath: readonly string[];
}

/** PEP 517's fallback when `[build-system]` names no backend. */
const LEGACY_BACKEND = "setuptools.build_meta:__legacy__";

/** `[build-system]` as a frontend reads it, or `undefined` when there is none. */
export function pypiBuildSystem(text: string, where: string): PypiBuildSystem | undefined {
  const doc = readTomlDocument(text, where);
  const system = tomlAt(doc, ["build-system"]);
  if (system === undefined) return undefined;
  if (system.kind !== "table") throw new VersionFileError(`${where}: [build-system] is not a table.`);
  const list = (key: string, required: boolean): string[] => {
    const value = system.entries.get(key);
    if (value === undefined && !required) return [];
    if (value?.kind !== "array" || value.items.some((item) => item.kind !== "string")) {
      throw new VersionFileError(`${where}: [build-system].${key} must be a list of strings.`);
    }
    return strings(value);
  };
  const backend = system.entries.get("build-backend");
  if (backend !== undefined && backend.kind !== "string") throw new VersionFileError(`${where}: [build-system].build-backend must be a string.`);
  return { requires: list("requires", true), backend: backend?.value ?? LEGACY_BACKEND, backendPath: list("backend-path", false) };
}

/** Whether an sdist member holds core metadata its backend derives from the
 *  project (`PKG-INFO`, an `*.egg-info` directory) rather than a file of it. */
export function isGeneratedSdistMember(path: string): boolean {
  const segments = path.split("/");
  return path === "PKG-INFO" || segments.slice(0, -1).some((segment) => segment.endsWith(".egg-info"));
}

// ---------------------------------------------------------------------------
// Requirements and edges
// ---------------------------------------------------------------------------

interface Requirement {
  readonly name: string;
  readonly url?: string;
  /** The specifier's span in the requirement text, parentheses excluded. */
  readonly specifier?: { readonly start: number; readonly end: number };
}

function requirementName(text: string): string | undefined {
  return /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(text)?.[1];
}

/** A PEP 508 requirement's name, and its URL or specifier. */
function parseRequirement(text: string): Requirement | undefined {
  const name = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*/.exec(text);
  if (!name) return undefined;
  let pos = name[0].length;
  const extras = /^\[[^\]]*\]\s*/.exec(text.slice(pos));
  if (extras) pos += extras[0].length;
  if (text[pos] === "@") {
    const url = /^@\s*(\S+)/.exec(text.slice(pos));
    return url ? { name: name[1]!, url: url[1]! } : undefined;
  }
  const marker = text.indexOf(";", pos);
  let start = pos;
  let end = marker < 0 ? text.length : marker;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (text[start] === "(" && text[end - 1] === ")") {
    start++;
    end--;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
  }
  return { name: name[1]!, ...(end > start ? { specifier: { start, end } } : {}) };
}

/** One pypi anchor of the workspace, as the edge reader sees it. */
export interface PypiProjectFile {
  readonly unit: UnitKey;
  /** Workspace-relative directory (`""` the root). */
  readonly dir: string;
  readonly text: string;
}

/** The workspace's pypi anchors by directory and by normalized name. */
export interface PypiProjectIndex {
  readonly units: ReadonlyMap<string, UnitKey>;
  readonly dirsByName: ReadonlyMap<string, readonly string[]>;
}

export function pypiProjectIndex(projects: readonly PypiProjectFile[]): PypiProjectIndex {
  const units = new Map<string, UnitKey>();
  const dirsByName = new Map<string, string[]>();
  for (const project of projects) {
    units.set(project.dir, project.unit);
    const where = projectFile(project.dir);
    const doc = readDocument(project.text, where);
    const name = doc ? stringAt(doc, ["project", "name"]) : tomlString(project.text, ["project", "name"], where)?.value;
    if (name === undefined) continue;
    const key = normalizePypiName(name);
    dirsByName.set(key, [...(dirsByName.get(key) ?? []), project.dir].sort());
  }
  return { units, dirsByName };
}

/** A runtime requirement of one project that names a sibling anchor's directory. */
export interface PypiLink {
  /** The requirement as written. */
  readonly requirement: string;
  /** Where it is listed (`project.dependencies`, `project.optional-dependencies.<extra>`). */
  readonly at: string;
  /** The sibling anchor's workspace-relative directory. */
  readonly target: string;
  readonly literal: TomlString;
}

const SOURCE_FORMS =
  "A sibling is read from [tool.uv.sources] (path = \"<dir>\" or workspace = true), [tool.poetry.dependencies] " +
  "(path = \"<dir>\"), or a file: reference rooted at ${PROJECT_ROOT} (PDM) or {root:uri} (Hatch).";

function projectFile(dir: string): string {
  return dir === "" ? PYPROJECT_TOML : `${dir}/${PYPROJECT_TOML}`;
}

/** `relative` resolved against the workspace-relative `dir`; `undefined` when it climbs above the workspace. */
function resolveWithin(dir: string, relative: string): string | undefined {
  const out = dir === "" ? [] : dir.split("/");
  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/** The path after a project-root placeholder, relative to the project. */
function rooted(rest: string): string {
  return decodeURIComponent(rest).replace(/^\/+/, "");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Each runtime requirement, with where it is listed. */
function runtimeRequirements(doc: TomlTable, where: string, problems: string[]): { at: string; literal: TomlString }[] {
  const found: { at: string; literal: TomlString }[] = [];
  const list = (value: TomlValue | undefined, at: string) => {
    if (value === undefined) return;
    if (value.kind !== "array" || value.items.some((item) => item.kind !== "string")) {
      problems.push(`${where}: ${at} is not a list of strings.`);
      return;
    }
    for (const item of value.items) found.push({ at, literal: item as TomlString });
  };
  list(tomlAt(doc, ["project", "dependencies"]), "project.dependencies");
  const optional = tomlAt(doc, ["project", "optional-dependencies"]);
  if (optional?.kind === "table") {
    for (const [extra, value] of optional.entries) list(value, `project.optional-dependencies.${extra}`);
  } else if (optional !== undefined) {
    problems.push(`${where}: project.optional-dependencies is not a table.`);
  }
  return found;
}

/** The source entries a tool table gives a requirement name, each a table. */
function sourcesFor(table: TomlValue | undefined, name: string): TomlTable[] {
  if (table?.kind !== "table") return [];
  const found: TomlTable[] = [];
  for (const [key, value] of table.entries) {
    if (normalizePypiName(key) !== name) continue;
    const items = value.kind === "array" ? value.items : [value];
    for (const item of items) if (item.kind === "table") found.push(item);
  }
  return found;
}

/**
 * One project as planning reads it: its links, and every reason it cannot be
 * planned — a static `project.version` no release can plan, a requirement that
 * cannot be read. Index, git and URL requirements are pins, and dependency
 * groups and dev tables are never read; a path naming no anchor is no link.
 */
export function readPypiProject(
  project: Pick<PypiProjectFile, "dir" | "text">,
  index: PypiProjectIndex,
): { links: PypiLink[]; problems: string[] } {
  const where = projectFile(project.dir);
  const problems: string[] = [];
  const links: PypiLink[] = [];
  let doc: TomlTable;
  try {
    doc = readTomlDocument(project.text, where);
  } catch (error) {
    if (error instanceof TomlError) return { links, problems: [error.message] };
    throw error;
  }
  if (!strings(tomlAt(doc, ["project", "dynamic"])).includes("version")) {
    const version = tomlString(project.text, ["project", "version"], where)?.value;
    const problem = version === undefined ? undefined : pypiVersionProblem(version);
    if (problem) problems.push(`${where}: project.version ${problem}.`);
  }
  const own = normalizePypiName(stringAt(doc, ["project", "name"]) ?? "");
  const uvSources = tomlAt(doc, ["tool", "uv", "sources"]);
  const poetryDependencies = tomlAt(doc, ["tool", "poetry", "dependencies"]);

  for (const { at, literal } of runtimeRequirements(doc, where, problems)) {
    const requirement = literal.value;
    const parsed = parseRequirement(requirement);
    if (!parsed) {
      problems.push(`${where}: '${requirement}' in ${at} cannot be read as a PEP 508 requirement.`);
      continue;
    }
    const name = normalizePypiName(parsed.name);
    if (name === own) continue;
    const named: { path: string; form: string; base: string }[] = [];
    if (parsed.url !== undefined) {
      const pdm = /^file:\/\/\/?\$\{PROJECT_ROOT\}(?=\/|$)/.exec(parsed.url);
      const hatch = /^\{root((?::parent)*):uri\}(?=\/|$)/.exec(parsed.url);
      if (pdm) {
        named.push({ path: rooted(parsed.url.slice(pdm[0].length)), form: "a file: reference rooted at ${PROJECT_ROOT}", base: project.dir });
      } else if (hatch) {
        const parents = hatch[1]!.split(":parent").length - 1;
        named.push({
          path: `${"../".repeat(parents)}${rooted(parsed.url.slice(hatch[0].length))}`,
          form: "a file: reference rooted at {root:uri}",
          base: project.dir,
        });
      } else if (/^file:/i.test(parsed.url)) {
        problems.push(`${where}: '${requirement}' in ${at} is a file: reference not rooted at the project, so which sibling it names cannot be read. ${SOURCE_FORMS}`);
        continue;
      }
    } else {
      for (const source of sourcesFor(uvSources, name)) {
        const path = source.entries.get("path");
        const workspace = source.entries.get("workspace");
        if (path?.kind === "string") named.push({ path: path.value, form: "[tool.uv.sources]", base: project.dir });
        else if (workspace?.kind === "boolean" && workspace.value) {
          const dirs = index.dirsByName.get(name) ?? [];
          if (dirs.length > 1) {
            problems.push(
              `${where}: '${requirement}' in ${at} names a workspace member through [tool.uv.sources], and ${dirs
                .map((dir) => `'${dir || "."}'`)
                .join(" and ")} are each called '${name}'.`,
            );
          } else if (dirs.length === 1) named.push({ path: dirs[0]!, form: "[tool.uv.sources]", base: "" });
        }
      }
      for (const source of sourcesFor(poetryDependencies, name)) {
        const path = source.entries.get("path");
        if (path?.kind === "string") named.push({ path: path.value, form: "[tool.poetry.dependencies]", base: project.dir });
      }
    }
    for (const { path, form, base } of named) {
      if (isAbsolutePath(path)) {
        problems.push(`${where}: '${requirement}' in ${at} names the absolute path '${path}' through ${form}; only a path relative to the project is read.`);
        continue;
      }
      const target = resolveWithin(base, path);
      if (target === undefined) {
        problems.push(`${where}: '${requirement}' in ${at} names '${path}' through ${form}, which leaves the workspace; a release plans only along paths inside it.`);
        continue;
      }
      if (target !== project.dir && index.units.has(target) && !links.some((l) => l.literal === literal && l.target === target)) {
        links.push({ requirement, at, target, literal });
      }
    }
  }
  return { links, problems };
}

// ---------------------------------------------------------------------------
// What apply rewrites
// ---------------------------------------------------------------------------

const MOVABLE = /^(==|>=|~=)\s*(\S+)$/;

/**
 * A dependent's `pyproject.toml` with every requirement linked to `targetDir`
 * that holds one `==`, `>=` or `~=` clause moved to `version`, keeping the
 * operator; any other shape is left as written.
 */
export function stampLinkedRequirements(
  text: string,
  dir: string,
  index: PypiProjectIndex,
  targetDir: string,
  version: string,
): string {
  const { links, problems } = readPypiProject({ dir, text }, index);
  if (problems.length > 0) throw new VersionFileError(problems.join("\n"));
  const edits: { start: number; end: number; text: string }[] = [];
  for (const link of links) {
    if (link.target !== targetDir || edits.some((edit) => edit.start === link.literal.start)) continue;
    const parsed = parseRequirement(link.requirement)!;
    if (!parsed.specifier) continue;
    const clause = link.requirement.slice(parsed.specifier.start, parsed.specifier.end);
    const movable = MOVABLE.exec(clause);
    if (!movable || normalizePypiVersion(movable[2]!) === undefined || movable[2]!.includes("*")) continue;
    const at = parsed.specifier.start + clause.length - movable[2]!.length;
    const moved = `${link.requirement.slice(0, at)}${version}${link.requirement.slice(parsed.specifier.end)}`;
    if (moved === link.requirement) continue;
    edits.push({ start: link.literal.start, end: link.literal.end, text: respellTomlString(text, link.literal, moved) });
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = spliceText(out, edit.start, edit.end, edit.text);
  return out;
}

function lockKind(file: string): "uv" | "poetry" | "pdm" {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (base === "uv.lock") return "uv";
  if (base === "poetry.lock") return "poetry";
  if (base === "pdm.lock") return "pdm";
  throw new VersionFileError(`${file} is not a lockfile the pypi ecosystem reads.`);
}

function directoryOf(file: string): string {
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
}

/** The directory a lockfile's package entry was locked from, as it records it. */
function lockedPath(kind: "uv" | "poetry" | "pdm", entry: TomlTable): string | undefined {
  if (kind === "uv") {
    const source = entry.entries.get("source");
    if (source?.kind !== "table") return undefined;
    for (const key of ["editable", "directory", "virtual"]) {
      const value = source.entries.get(key);
      if (value?.kind === "string") return value.value;
    }
    return undefined;
  }
  if (kind === "poetry") {
    const source = entry.entries.get("source");
    if (source?.kind !== "table" || stringAt(source, ["type"]) !== "directory") return undefined;
    return stringAt(source, ["url"]);
  }
  return stringAt(entry, ["path"]);
}

/**
 * A lockfile (`uv.lock`, `poetry.lock`, `pdm.lock`, workspace-relative `file`)
 * with the `version` of every package locked from `target.dir` moved to
 * `version` — PEP 440 normalized as uv and PDM record it, as written for
 * Poetry. `undefined` when it records none. A package locked from a registry
 * is a pin and is left alone.
 */
export function stampPypiLockfile(
  text: string,
  file: string,
  target: { readonly name: string; readonly dir: string },
  version: string,
): string | undefined {
  const kind = lockKind(file);
  const spelled = kind === "poetry" ? version : normalizePypiVersion(version);
  if (spelled === undefined) throw new VersionFileError(`${file}: '${version}' is not a version PEP 440 can spell.`);
  const doc = readTomlDocument(text, file);
  const packages = doc.entries.get("package");
  if (packages?.kind !== "array") return undefined;
  const edits: TomlString[] = [];
  for (const entry of packages.items) {
    if (entry.kind !== "table" || normalizePypiName(stringAt(entry, ["name"]) ?? "") !== normalizePypiName(target.name)) continue;
    const path = lockedPath(kind, entry);
    if (path === undefined || isAbsolutePath(path) || resolveWithin(directoryOf(file), path) !== target.dir) continue;
    const recorded = entry.entries.get("version");
    if (recorded === undefined) continue;
    if (recorded.kind !== "string") {
      throw new VersionFileError(`${file}: the '${target.name}' package records a version that is not a string.`);
    }
    edits.push(recorded);
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = spliceText(out, edit.start, edit.end, respellTomlString(out, edit, spelled));
  return out === text ? undefined : out;
}

/** A Python value, as `json.dumps` writes it. */
type PyValue = null | boolean | bigint | string | PyValue[] | Map<string, PyValue>;

function toPy(value: TomlValue, where: string): PyValue {
  switch (value.kind) {
    case "string":
    case "boolean":
    case "integer":
      return value.value;
    case "array":
      return value.items.map((item) => toPy(item, where));
    case "table":
      return new Map([...value.entries].map(([key, item]) => [key, toPy(item, where)]));
    default:
      throw new VersionFileError(`${where} holds a ${value.kind} where a content hash is computed, which cannot be written as Python's json.dumps writes it.`);
  }
}

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function pyString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const char = value[i]!;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

/** `json.dumps(value, sort_keys=True)`, byte for byte. */
function pythonJson(value: PyValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return pyString(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  const keys = [...value.keys()].sort(compareCodePoints);
  return `{${keys.map((key) => `${pyString(key)}: ${pythonJson(value.get(key)!)}`).join(", ")}}`;
}

function pyAt(doc: TomlTable, path: readonly string[], where: string): PyValue | undefined {
  const value = tomlAt(doc, path);
  return value === undefined ? undefined : toPy(value, where);
}

/** What Poetry hashes into `content-hash` (its `Locker._get_content_hash`). */
function poetryHashInput(text: string, where: string): string {
  const doc = readTomlDocument(text, where);
  const project = new Map<string, PyValue>();
  for (const key of ["requires-python", "dependencies", "optional-dependencies"]) {
    const value = pyAt(doc, ["project", key], where);
    if (value !== undefined) project.set(key, value);
  }
  const legacy = ["dependencies", "source", "extras", "dev-dependencies"];
  const poetry = new Map<string, PyValue>();
  for (const key of [...legacy, "group"]) {
    const value = pyAt(doc, ["tool", "poetry", key], where);
    if (value === undefined && (!legacy.includes(key) || project.size > 0)) continue;
    poetry.set(key, value ?? null);
  }
  const relevant: PyValue =
    project.size > 0 ? new Map<string, PyValue>([["project", project], ["tool", new Map([["poetry", poetry]])]]) : poetry;
  return pythonJson(relevant);
}

/** What PDM hashes into `content_hash` (its `PyProject.content_hash`). */
function pdmHashInput(text: string, where: string): string {
  const doc = readTomlDocument(text, where);
  const groups = new Map<string, PyValue>();
  const groupName = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
  const declared = pyAt(doc, ["dependency-groups"], where);
  if (declared instanceof Map) {
    for (const [name, deps] of declared) {
      const key = groupName(name);
      if (groups.has(key)) throw new VersionFileError(`${where}: the dependency group '${key}' is declared twice.`);
      groups.set(key, Array.isArray(deps) ? [...deps] : deps);
    }
  }
  const dev = pyAt(doc, ["tool", "pdm", "dev-dependencies"], where);
  if (dev instanceof Map) {
    for (const [name, deps] of dev) {
      const key = groupName(name);
      const existing = groups.get(key);
      groups.set(key, [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(deps) ? deps : [])]);
    }
  }
  return pythonJson(
    new Map<string, PyValue>([
      ["sources", pyAt(doc, ["tool", "pdm", "source"], where) ?? []],
      ["dependencies", pyAt(doc, ["project", "dependencies"], where) ?? []],
      ["dev-dependencies", groups],
      ["optional-dependencies", pyAt(doc, ["project", "optional-dependencies"], where) ?? new Map()],
      ["requires-python", pyAt(doc, ["project", "requires-python"], where) ?? ""],
      ["resolution", pyAt(doc, ["tool", "pdm", "resolution"], where) ?? new Map()],
    ]),
  );
}

/**
 * A `poetry.lock` or `pdm.lock` whose content hash follows its project's
 * `pyproject.toml` from `before` to `after`, `sha256` giving a text's hex
 * digest. The recorded hash must be the one the tool computes from `before`:
 * otherwise the lockfile is already stale, or its tool hashes another way, and
 * a moved hash would claim a freshness nobody checked. `undefined` when the
 * lockfile records no content hash (`uv.lock`).
 */
export function movePypiLockContentHash(
  text: string,
  file: string,
  before: string,
  after: string,
  pyproject: string,
  sha256: (text: string) => string,
): string | undefined {
  const kind = lockKind(file);
  if (kind === "uv") return undefined;
  const doc = readTomlDocument(text, file);
  const recorded = tomlAt(doc, ["metadata", kind === "poetry" ? "content-hash" : "content_hash"]);
  if (recorded === undefined) return undefined;
  if (recorded.kind !== "string") throw new VersionFileError(`${file}: its content hash is not a string.`);
  const prefix = kind === "pdm" ? "sha256:" : "";
  if (!recorded.value.startsWith(prefix)) {
    throw new VersionFileError(`${file}: its content hash '${recorded.value}' is not a sha256 one, so it cannot be moved with ${pyproject}.`);
  }
  const input = kind === "poetry" ? poetryHashInput : pdmHashInput;
  const tool = kind === "poetry" ? "poetry lock" : "pdm lock";
  if (`${prefix}${sha256(input(before, pyproject))}` !== recorded.value) {
    throw new VersionFileError(
      `${file}: its content hash is not the one ${pyproject} as it stands gives, so it cannot be moved with the ` +
        `requirement a release rewrites there. Run \`${tool}\` so the lockfile matches ${pyproject}, then apply again.`,
    );
  }
  const moved = `${prefix}${sha256(input(after, pyproject))}`;
  return moved === recorded.value ? undefined : spliceText(text, recorded.start, recorded.end, respellTomlString(text, recorded, moved));
}

// ---------------------------------------------------------------------------
// The simple index
// ---------------------------------------------------------------------------

/** A file a project page lists; `href` as written, less its fragment. */
export interface IndexFile {
  readonly filename: string;
  readonly href: string;
  readonly sha256?: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, entity: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[entity]!,
  );
}

function withoutFragment(href: string): { href: string; sha256?: string } {
  const hash = href.indexOf("#");
  if (hash < 0) return { href };
  const sha256 = /(?:^|&)sha256=([0-9a-fA-F]{64})(?:&|$)/.exec(href.slice(hash + 1))?.[1];
  return { href: href.slice(0, hash), ...(sha256 ? { sha256: sha256.toLowerCase() } : {}) };
}

/** The files a PEP 503 (HTML) or PEP 691 (JSON, when `json`) project page lists. */
export function simpleIndexFiles(body: string, json: boolean, where: string): IndexFile[] {
  if (json) {
    let page: { files?: unknown };
    try {
      page = JSON.parse(body) as { files?: unknown };
    } catch {
      throw new VersionFileError(`${where} is not a JSON project page.`);
    }
    if (!Array.isArray(page.files)) throw new VersionFileError(`${where} lists no 'files'.`);
    return (page.files as { filename?: unknown; url?: unknown; hashes?: { sha256?: unknown } }[]).flatMap((file) => {
      if (typeof file.filename !== "string" || typeof file.url !== "string") return [];
      const link = withoutFragment(file.url);
      const sha256 = typeof file.hashes?.sha256 === "string" ? file.hashes.sha256.toLowerCase() : link.sha256;
      return [{ filename: file.filename, href: link.href, ...(sha256 ? { sha256 } : {}) }];
    });
  }
  const found: IndexFile[] = [];
  const scan = new AnchorScan(body);
  for (let at = scan.nextOpen(0); at !== -1; ) {
    const match = scan.matchAt(at);
    if (!match) {
      at = scan.nextOpen(at + 1);
      continue;
    }
    const link = withoutFragment(decodeEntities(match.href));
    found.push({ filename: decodeEntities(withoutTags(match.text).trim()), ...link });
    at = scan.nextOpen(match.end);
  }
  return found;
}

const WHITESPACE = /\s/;
const HREF_AT = /href\s*=\s*/y;

/**
 * A linear scan for `<a ... href=... >text</a>` as a case-insensitive regex
 * would match it, with every search remembering its last answer so a page that
 * lacks a needle is searched for it once.
 */
class AnchorScan {
  private readonly lower: string;
  private readonly seen = new Map<string, { from: number; at: number }>();
  private lastHead: { from: number; head: { at: number; value: number } | undefined } | undefined;
  private noCloseFrom: number | undefined;

  constructor(private readonly body: string) {
    this.lower = body.replace(/[A-Z]/g, (c) => c.toLowerCase());
  }

  private find(needle: string, from: number, text: string): number {
    const key = text === this.body ? `b${needle}` : `l${needle}`;
    const last = this.seen.get(key);
    if (last && last.from <= from && (last.at === -1 || from <= last.at)) return last.at;
    const at = text.indexOf(needle, from);
    this.seen.set(key, { from, at });
    return at;
  }

  /** The next `<a` followed by whitespace at or after `from`, else -1. */
  nextOpen(from: number): number {
    for (let at = this.find("<a", from, this.lower); at !== -1; at = this.find("<a", at + 1, this.lower)) {
      if (WHITESPACE.test(this.lower.charAt(at + 2))) return at;
    }
    return -1;
  }

  /** The first `href\s*=\s*` at or after `from`, with where its value starts. */
  private nextHead(from: number): { at: number; value: number } | undefined {
    const last = this.lastHead;
    if (last && last.from <= from && (!last.head || from <= last.head.at)) return last.head;
    let head: { at: number; value: number } | undefined;
    for (let at = this.find("href", from, this.lower); at !== -1; at = this.find("href", at + 1, this.lower)) {
      HREF_AT.lastIndex = at;
      const m = HREF_AT.exec(this.lower);
      if (m) {
        head = { at, value: at + m[0].length };
        break;
      }
    }
    this.lastHead = { from, head };
    return head;
  }

  /** The link whose anchor opens at `open`, with the text up to the first `</a\s*>` and where that ends. */
  matchAt(open: number): { href: string; text: string; end: number } | undefined {
    const limit = this.find(">", open + 3, this.body);
    // every value ends at or after the first `>`, so no close past it means none for this tag
    if (limit === -1 || (this.noCloseFrom !== undefined && limit + 1 >= this.noCloseFrom)) return undefined;
    for (let head = this.nextHead(open + 3); head && head.at < limit; head = this.nextHead(head.at + 1)) {
      const v = head.value;
      const quote = this.body.charAt(v);
      const values: { href: string; end: number }[] = [];
      if (quote === '"' || quote === "'") {
        const q = this.find(quote, v + 1, this.body);
        if (q !== -1) values.push({ href: this.body.slice(v + 1, q), end: q + 1 });
      }
      let end = v;
      while (end < this.body.length && !WHITESPACE.test(this.body.charAt(end)) && this.body.charAt(end) !== ">") end++;
      if (end > v) values.push({ href: this.body.slice(v, end), end });
      for (const value of values) {
        const gt = this.find(">", value.end, this.body);
        if (gt === -1) continue;
        const close = this.closeFrom(gt + 1);
        if (close) return { href: value.href, text: this.body.slice(gt + 1, close.start), end: close.end };
      }
    }
    return undefined;
  }

  /** The first `</a`, optional whitespace, `>` at or after `from`. */
  private closeFrom(from: number): { start: number; end: number } | undefined {
    if (this.noCloseFrom !== undefined && from >= this.noCloseFrom) return undefined;
    for (let at = this.find("</a", from, this.lower); at !== -1; at = this.find("</a", at + 1, this.lower)) {
      let end = at + 3;
      while (end < this.lower.length && WHITESPACE.test(this.lower.charAt(end))) end++;
      if (this.lower.charAt(end) === ">") return { start: at, end: end + 1 };
    }
    this.noCloseFrom = Math.min(this.noCloseFrom ?? from, from);
    return undefined;
  }
}

/** `html` less its `<...>` tags; a `<` with no closing `>` stays text. */
function withoutTags(html: string): string {
  let text = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    if (open === -1) return text + html.slice(at);
    const close = html.indexOf(">", open);
    if (close === -1) return text + html.slice(at);
    text += html.slice(at, open);
    at = close + 1;
  }
}

/** `name-version` of a distribution file, as its filename spells them. */
function distributionOf(filename: string): { name: string; version: string } | undefined {
  if (filename.endsWith(".tar.gz")) {
    const base = filename.slice(0, -".tar.gz".length);
    const dash = base.lastIndexOf("-");
    return dash > 0 ? { name: base.slice(0, dash), version: base.slice(dash + 1) } : undefined;
  }
  if (filename.endsWith(".whl")) {
    const [name, version] = filename.split("-");
    return name && version ? { name, version } : undefined;
  }
  return undefined;
}

/** The sdist of `name` at `version` a project page lists, `undefined` when it lists none. */
export function sdistInIndex(files: readonly IndexFile[], name: string, version: string, where: string): IndexFile | undefined {
  const wanted = versionKey(version);
  const matches = files.filter((file) => {
    if (!file.filename.endsWith(".tar.gz")) return false;
    const dist = distributionOf(file.filename);
    return dist !== undefined && normalizePypiName(dist.name) === normalizePypiName(name) && versionKey(dist.version) === wanted;
  });
  const hrefs = [...new Set(matches.map((file) => file.href))];
  if (hrefs.length > 1) {
    throw new VersionFileError(`${where} lists ${hrefs.length} sdists of ${name} ${version} (${hrefs.join(", ")}), so which one is published cannot be decided.`);
  }
  return matches[0];
}

/** Every version a project page lists a distribution of, PEP 440 normalized. */
export function versionsInIndex(files: readonly IndexFile[], name: string): string[] {
  const versions = new Set<string>();
  for (const file of files) {
    const dist = distributionOf(file.filename);
    const normalized = dist && normalizePypiName(dist.name) === normalizePypiName(name) ? normalizePypiVersion(dist.version) : undefined;
    if (normalized !== undefined) versions.add(normalized);
  }
  return [...versions];
}

/** Where a distribution publishes: `<registry>/<normalized name>`. */
export function pypiDestination(registry: string, name: string): string {
  return `${trimTrailingSlashes(registry)}/${normalizePypiName(name)}`;
}
