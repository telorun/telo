/**
 * The external packages a crate links into the artifact it builds, as the text
 * its layer holds at `Cargo.lock`: one `name version source` line per package
 * outside the workspace (a package with no source, two fields), sorted, each
 * ending in a newline. Only a crate with a linked-artifact target (`bin`,
 * `cdylib`, `staticlib`, `dylib`) has one, so a lockfile-only bump of a
 * dependency releases the binaries that link it and never a library.
 *
 * The closure follows normal and build edges, transitively, never dev ones; it
 * walks through workspace members, which are units of their own and are never
 * lines. It is read either from the tree (`cargo metadata` over every feature
 * and platform) or from a published `.crate` (its `Cargo.lock`, the root's own
 * edges taken from its packaged `Cargo.toml`); both give the same text.
 */

import { dottedKey, quotedValue } from "./cargo.js";

/** Target kinds whose artifact links its dependencies in. */
export const LINKED_ARTIFACT_KINDS: readonly string[] = ["bin", "cdylib", "staticlib", "dylib"];

/** Whether a crate's `cargo metadata` targets include a linked artifact. */
export function linksArtifact(targets: readonly { readonly kind: readonly string[] }[]): boolean {
  return targets.some((target) => target.kind.some((kind) => LINKED_ARTIFACT_KINDS.includes(kind)));
}

function canonical(lines: Iterable<string>): string {
  return [...new Set(lines)]
    .sort()
    .map((line) => `${line}\n`)
    .join("");
}

function line(name: string, version: string, source: string | null | undefined): string {
  return source ? `${name} ${version} ${source}` : `${name} ${version}`;
}

interface MetadataPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source?: string | null;
}

interface MetadataNode {
  readonly id: string;
  readonly deps?: readonly { readonly pkg: string; readonly dep_kinds?: readonly { readonly kind: string | null }[] }[];
}

/**
 * The closure of the package `rootId` in a `cargo metadata` answer read with
 * its resolve (no `--no-deps`).
 */
export function closureFromMetadata(metadata: unknown, rootId: string): string {
  const read = metadata as {
    packages?: readonly MetadataPackage[];
    workspace_members?: readonly string[];
    resolve?: { nodes?: readonly MetadataNode[] } | null;
  };
  if (!read.resolve?.nodes) throw new Error(`cargo metadata carries no resolve, so the closure of '${rootId}' cannot be read.`);
  const packages = new Map((read.packages ?? []).map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(read.resolve.nodes.map((node) => [node.id, node]));
  const members = new Set(read.workspace_members ?? []);
  if (!nodes.has(rootId)) throw new Error(`cargo metadata resolves no package '${rootId}'.`);

  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  const lines: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!members.has(id)) {
      const pkg = packages.get(id);
      if (!pkg) throw new Error(`cargo metadata resolves '${id}' but lists no such package.`);
      lines.push(line(pkg.name, pkg.version, pkg.source));
    }
    const node = nodes.get(id);
    if (!node) throw new Error(`cargo metadata lists '${id}' with no resolve node.`);
    for (const dep of node.deps ?? []) {
      if (!(dep.dep_kinds ?? []).some((kind) => kind.kind === null || kind.kind === "build")) continue;
      if (seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return canonical(lines);
}

interface LockPackage {
  readonly name: string;
  readonly version: string;
  readonly source?: string;
  readonly dependencies: readonly string[];
}

/** The `[[package]]` entries of a `Cargo.lock` in the layout cargo writes. */
function lockPackages(text: string, where: string): LockPackage[] {
  const out: LockPackage[] = [];
  let current: { name?: string; version?: string; source?: string; dependencies: string[] } | undefined;
  let inDependencies = false;
  const close = () => {
    if (!current) return;
    if (current.name === undefined || current.version === undefined) {
      throw new Error(`${where}: a [[package]] entry records no name or version.`);
    }
    out.push({
      name: current.name,
      version: current.version,
      ...(current.source !== undefined ? { source: current.source } : {}),
      dependencies: current.dependencies,
    });
    current = undefined;
  };
  for (const raw of text.split("\n")) {
    const text = raw.replace(/\r$/, "").trim();
    if (inDependencies) {
      for (const item of text.matchAll(/"([^"]*)"/g)) current!.dependencies.push(item[1]!);
      if (text.includes("]")) inDependencies = false;
      continue;
    }
    if (text.startsWith("[")) {
      close();
      if (text === "[[package]]") current = { dependencies: [] };
      continue;
    }
    if (!current) continue;
    const entry = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*)$/.exec(text);
    if (!entry) continue;
    const [, key, value] = entry;
    if (key === "dependencies") {
      const body = value!.replace(/^\[/, "");
      for (const item of body.matchAll(/"([^"]*)"/g)) current.dependencies.push(item[1]!);
      inDependencies = !body.includes("]");
      continue;
    }
    const quoted = /^"([^"]*)"/.exec(value!);
    if (!quoted) continue;
    if (key === "name") current.name = quoted[1]!;
    else if (key === "version") current.version = quoted[1]!;
    else if (key === "source") current.source = quoted[1]!;
  }
  close();
  return out;
}

/** The package a lock dependency names: `name`, `name version` or `name version (source)`. */
function lockTarget(packages: readonly LockPackage[], reference: string, where: string): LockPackage {
  const parsed = /^(\S+)(?: (\S+))?(?: \((.*)\))?$/.exec(reference.trim());
  if (!parsed) throw new Error(`${where}: '${reference}' names no package.`);
  const [, name, version, source] = parsed;
  const found = packages.filter(
    (pkg) => pkg.name === name && (version === undefined || pkg.version === version) && (source === undefined || pkg.source === source),
  );
  if (found.length !== 1) {
    throw new Error(`${where}: '${reference}' names ${found.length === 0 ? "no package" : `${found.length} packages`} in the lockfile.`);
  }
  return found[0]!;
}

/** The basic string a TOML value starts with. */
function leadingString(value: string): string | undefined {
  return /^[ \t]*"([^"]*)"/.exec(value)?.[1];
}

const LINKED_DEPENDENCY_TABLES = new Set(["dependencies", "build-dependencies"]);

/**
 * The package names a `Cargo.toml` depends on for normal and build use,
 * target-specific tables included, a renamed dependency by its `package`.
 */
function linkedDependencyNames(text: string): Set<string> {
  const packages = new Map<string, string>();
  let inline: string | undefined;
  let table: { scope: string; key: string; package?: string } | undefined;
  const closeTable = () => {
    if (table) packages.set(`${table.scope}\0${table.key}`, table.package ?? table.key);
    table = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^[ \t]*(\[\[?)([^[\]]+)\]\]?[ \t]*(#.*)?$/.exec(line);
    if (header) {
      closeTable();
      inline = undefined;
      if (header[1] === "[[") continue;
      const segments = dottedKey(header[2]!);
      const at = segments[0] === "target" ? 2 : 0;
      const scope = segments.slice(0, at + 1).join("\0");
      if (segments.length === at + 1 && LINKED_DEPENDENCY_TABLES.has(segments[at]!)) inline = scope;
      else if (segments.length === at + 2 && LINKED_DEPENDENCY_TABLES.has(segments[at]!)) table = { scope, key: segments[at + 1]! };
      continue;
    }
    const entry = /^[ \t]*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:[ \t]*\.[ \t]*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)[ \t]*=(.*)$/.exec(line);
    if (!entry) continue;
    const key = dottedKey(entry[1]!);
    if (table) {
      if (key.length === 1 && key[0] === "package") table.package = leadingString(entry[2]!);
      continue;
    }
    if (inline === undefined) continue;
    const renamed =
      key.length === 1
        ? quotedValue(entry[2]!, "package")?.value
        : key.length === 2 && key[1] === "package"
          ? leadingString(entry[2]!)
          : undefined;
    const id = `${inline}\0${key[0]!}`;
    packages.set(id, renamed ?? packages.get(id) ?? key[0]!);
  }
  closeTable();
  return new Set(packages.values());
}

/**
 * The closure of the crate `root` read from a published `.crate`: its
 * `Cargo.lock`, and its packaged `Cargo.toml` for the root's own non-dev
 * edges, which the lockfile does not tell from dev ones. `members` are the
 * workspace's member names, never lines.
 */
export function closureFromLock(
  lockText: string,
  manifestText: string,
  root: { readonly name: string; readonly version: string },
  members: readonly string[],
  where: string,
): string {
  const packages = lockPackages(lockText, where);
  const roots = packages.filter((pkg) => pkg.name === root.name && pkg.version === root.version && pkg.source === undefined);
  if (roots.length !== 1) throw new Error(`${where}: the lockfile records no single '${root.name} ${root.version}' path package.`);
  const linked = linkedDependencyNames(manifestText);
  const excluded = new Set(members);
  const seen = new Set<LockPackage>([roots[0]!]);
  const queue = roots[0]!.dependencies.map((reference) => lockTarget(packages, reference, where)).filter((pkg) => linked.has(pkg.name));
  for (const pkg of queue) seen.add(pkg);
  const lines: string[] = [];
  while (queue.length > 0) {
    const pkg = queue.shift()!;
    if (!excluded.has(pkg.name)) lines.push(line(pkg.name, pkg.version, pkg.source));
    for (const reference of pkg.dependencies) {
      const target = lockTarget(packages, reference, where);
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return canonical(lines);
}
