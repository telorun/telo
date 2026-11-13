/**
 * `adopt changesets` — the one-time import of a changesets setup.
 *
 * Every workspace package becomes a `release.units` entry with `ecosystem: npm`;
 * `fixed` groups become `release.groups`; `ignore` becomes `!` entries; each
 * pending change file becomes one fragment of the same id naming the same units
 * with the same body (`major` / `minor` / `patch` → `Changed` / `Added` /
 * `Fixed`). The npm layers are then seeded from the registry as `verify --write`
 * records them — a candidate version included — and `.changeset/` is deleted.
 * `linked` groups have no counterpart and are refused. CI steps and
 * `@changesets/*` dependencies are listed, never rewritten.
 */

import { GLOB_PRUNE_DIRS, lastMatchIndex, selectByPatterns } from "@telorun/glob";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import type { FragmentKind } from "../bump-level.js";
import { serializeFragment, type UnitKey } from "../fragment.js";
import { WORKSPACE_FILENAME } from "../marker-reader.js";
import { LEDGER_PATH } from "../ledger.js";
import type { ReleaseHost } from "./host.js";
import { PENDING_DIR, writeLedger } from "./ledger-store.js";
import { loadWorkspaceFor, verifyLedger, type Argv } from "./operations.js";
import { directoriesUnder } from "./workspace.js";

const BUMP_KIND: Readonly<Record<string, FragmentKind>> = { major: "Changed", minor: "Added", patch: "Fixed" };

export interface AdoptResult {
  readonly root: string;
  readonly written: readonly string[];
  readonly deleted: readonly string[];
  /** What the import did not rewrite, for the author to: CI steps, dependencies,
   *  private packages. */
  readonly leftBehind: readonly string[];
}

interface ChangesetsConfig {
  fixed?: unknown;
  linked?: unknown;
  ignore?: unknown;
}

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly private: boolean;
}

export async function adoptChangesets(host: ReleaseHost, from: string, argv: Argv): Promise<AdoptResult> {
  const root = changesetsRoot(from);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".changeset", "config.json"), "utf8")) as ChangesetsConfig;
  const linked = Array.isArray(config.linked) ? config.linked.filter((group) => Array.isArray(group) && group.length > 0) : [];
  if (linked.length > 0) {
    throw new Error(
      `.changeset/config.json declares ${linked.length} 'linked' group(s), which have no counterpart: a unit's ` +
        `version is its own, or shared whole by a group. Turn each into a 'fixed' group or remove it, then adopt.`,
    );
  }
  const markerFile = path.join(root, WORKSPACE_FILENAME);
  const existingMarker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8") : undefined;
  if (existingMarker !== undefined && (parseDocument(existingMarker).toJSON() as { release?: unknown } | null)?.release !== undefined) {
    throw new Error(`${WORKSPACE_FILENAME} already declares 'release:', so there is nothing to adopt into.`);
  }

  const packages = workspacePackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const select = (patterns: unknown, where: string): WorkspacePackage[] => {
    const list = Array.isArray(patterns) ? patterns.filter((p): p is string => typeof p === "string") : [];
    for (const pattern of list) {
      if (!/[*?]/.test(pattern) && !byName.has(pattern)) {
        throw new Error(`.changeset/config.json ${where} names '${pattern}', which is not a package of this workspace.`);
      }
    }
    return packages.filter((pkg) => list.some((pattern) => pattern === pkg.name || lastMatchIndex(pkg.name, [pattern]) >= 0));
  };
  const ignored = new Set(select(config.ignore, "ignore").map((pkg) => pkg.dir));
  const leftBehind: string[] = [];
  const units: string[] = [];
  const excluded: string[] = [];
  for (const pkg of packages) {
    units.push(pkg.dir);
    if (ignored.has(pkg.dir)) excluded.push(pkg.dir);
    else if (pkg.private) {
      excluded.push(pkg.dir);
      leftBehind.push(
        `${pkg.dir}: private package ${pkg.name} publishes nothing, so it is excluded ('!${pkg.dir}'). ` +
          `Declare its 'payload:' to version it.`,
      );
    }
  }
  const groups = (Array.isArray(config.fixed) ? config.fixed : []).map((group, index) =>
    [`fixed-${index + 1}`, select(group, `fixed[${index}]`).map((pkg) => pkg.dir).filter((dir) => !excluded.includes(dir))] as const,
  ).filter(([, members]) => members.length > 0);

  const written: string[] = [];
  const marker = [
    ...(existingMarker !== undefined ? [existingMarker.replace(/\s*$/, ""), ""] : []),
    "release:",
    "  units:",
    ...units.map((dir) => `    - { path: ${yamlScalar(dir)}, ecosystem: npm }`),
    ...excluded.map((dir) => `    - ${yamlScalar(`!${dir}`)}`),
    ...(groups.length > 0
      ? ["  groups:", ...groups.map(([name, members]) => `    ${name}: [${members.map(yamlScalar).join(", ")}]`)]
      : []),
    "",
  ].join("\n");
  fs.writeFileSync(markerFile, marker, "utf8");
  written.push(WORKSPACE_FILENAME);

  const changesetDir = path.join(root, ".changeset");
  fs.mkdirSync(path.join(root, PENDING_DIR), { recursive: true });
  for (const name of fs.readdirSync(changesetDir).filter((file) => file.endsWith(".md") && file !== "README.md").sort()) {
    const { units: named, body } = readChangeset(fs.readFileSync(path.join(changesetDir, name), "utf8"), `.changeset/${name}`, byName);
    const fragment = `${PENDING_DIR}/${name.replace(/\.md$/, ".yaml")}`;
    const kept = new Map([...named].filter(([dir]) => !excluded.includes(dir)));
    if (kept.size === 0) {
      leftBehind.push(`.changeset/${name}: names only excluded packages, so no fragment was written.`);
      continue;
    }
    fs.writeFileSync(path.join(root, fragment), serializeFragment(kept, body), "utf8");
    written.push(fragment);
  }

  const workspace = loadWorkspaceFor(host, root);
  const { ledger, diagnostics } = await verifyLedger(host, workspace, argv, () => {});
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (error) throw new Error(`${error.code}: ${error.message}`);
  writeLedger(root, ledger);
  written.push(LEDGER_PATH);

  const deleted = fs.readdirSync(changesetDir).map((name) => `.changeset/${name}`).sort();
  fs.rmSync(changesetDir, { recursive: true, force: true });

  leftBehind.push(...changesetsMentions(root, packages));
  return { root, written, deleted, leftBehind };
}

function changesetsRoot(from: string): string {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".changeset", "config.json"))) return dir;
    if (path.dirname(dir) === dir) {
      throw new Error(`No .changeset/config.json in '${path.resolve(from)}' or any parent directory: nothing to adopt.`);
    }
  }
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("!") ? value : JSON.stringify(value);
}

/** The workspace packages, from `pnpm-workspace.yaml` or `package.json`'s
 *  `workspaces`; with neither, the root package alone. */
function workspacePackages(root: string): WorkspacePackage[] {
  let patterns: string[] | undefined;
  const pnpm = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpm)) {
    const value = parseDocument(fs.readFileSync(pnpm, "utf8")).toJSON() as { packages?: unknown } | null;
    if (Array.isArray(value?.packages)) patterns = value.packages.filter((p): p is string => typeof p === "string");
  }
  const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces?: unknown };
  if (!patterns) {
    const workspaces = rootManifest.workspaces;
    const list = Array.isArray(workspaces)
      ? workspaces
      : workspaces && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)
        ? ((workspaces as { packages: unknown[] }).packages)
        : undefined;
    if (list) patterns = list.filter((p): p is string => typeof p === "string");
  }
  const dirs = patterns
    ? [...selectByPatterns(directoriesUnder(root), patterns.map((p) => p.replace(/\/+$/, "")), { applyDefaultIgnore: false })]
    : [""];
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs.sort()) {
    if (dir.split("/").some((segment) => GLOB_PRUNE_DIRS.has(segment))) continue;
    const file = path.join(root, dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; version?: unknown; private?: unknown };
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
    packages.push({ name: pkg.name, dir: dir === "" ? "." : dir, private: pkg.private === true });
  }
  return packages;
}

function readChangeset(
  text: string,
  where: string,
  byName: ReadonlyMap<string, WorkspacePackage>,
): { units: Map<UnitKey, FragmentKind>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${where} has no '---' front matter naming its packages.`);
  const front = (parseDocument(match[1]!).toJSON() ?? {}) as Record<string, unknown>;
  const units = new Map<UnitKey, FragmentKind>();
  for (const [name, bump] of Object.entries(front)) {
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`${where} names '${name}', which is not a package of this workspace.`);
    const kind = typeof bump === "string" ? BUMP_KIND[bump] : undefined;
    if (!kind) throw new Error(`${where} gives '${name}' the bump '${String(bump)}'; expected major, minor or patch.`);
    units.set(pkg.dir, kind);
  }
  return { units, body: match[2]!.trim() };
}

/** CI lines and dependencies that still name changesets. */
function changesetsMentions(root: string, packages: readonly WorkspacePackage[]): string[] {
  const found: string[] = [];
  const workflows = path.join(root, ".github", "workflows");
  if (fs.existsSync(workflows)) {
    for (const name of fs.readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file)).sort()) {
      fs.readFileSync(path.join(workflows, name), "utf8").split("\n").forEach((line, index) => {
        if (/changeset/i.test(line)) found.push(`.github/workflows/${name}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  const manifests = [".", ...packages.map((pkg) => pkg.dir)];
  for (const dir of [...new Set(manifests)]) {
    const file = path.join(root, dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const section of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys((pkg[section] as Record<string, unknown> | undefined) ?? {})) {
        if (name.startsWith("@changesets/")) found.push(`${dir === "." ? "" : `${dir}/`}package.json: ${section}.${name}`);
      }
    }
    for (const [script, command] of Object.entries((pkg.scripts as Record<string, unknown> | undefined) ?? {})) {
      if (typeof command === "string" && /\bchangeset\b/.test(command)) {
        found.push(`${dir === "." ? "" : `${dir}/`}package.json: scripts.${script}: ${command}`);
      }
    }
  }
  return found;
}
