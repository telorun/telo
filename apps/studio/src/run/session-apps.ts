import type { Workspace } from "../model";
import type { SessionAppSpec, SessionPort } from "./types";

/** What the app set needs to know of one Application of the workspace. */
export interface WorkspaceApplication {
  /** The module's `telo.yaml`, as the editor holds it. */
  filePath: string;
  /** Its `metadata.name`, which the session name is derived from. */
  name: string;
  /** The ports it declares, resolved against its env files. */
  ports: SessionPort[];
  /** The telo version it is edited against: known, still being found, or
   *  unavailable with the reason. */
  telo: { version: string } | { pending: true } | { refusal: string };
}

/** One app of the set, with the module it is. */
export interface DesiredApp {
  appPath: string;
  spec: SessionAppSpec;
}

export interface DesiredAppSet {
  apps: DesiredApp[];
  /** False while an app's telo version is still being found: the set is not
   *  sent until it settles, since every change to it recreates the pod. */
  settled: boolean;
  /** Whether the apps name telo versions: the session takes the set only when
   *  this matches what its runner said of itself. */
  versioned: boolean;
}

/** Names a session's own containers already use. */
const RESERVED_NAMES = new Set(["workspace", "agent"]);
const MAX_NAME_LENGTH = 63;

/** A DNS label for an Application name: `TodoApi` → `todo-api`. */
function labelOf(name: string): string {
  const label = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, "");
  if (label === "") return "app";
  return RESERVED_NAMES.has(label) ? `app-${label}` : label;
}

function withSuffix(label: string, n: number): string {
  const suffix = `-${n}`;
  return `${label.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
}

function relativeTo(rootDir: string, filePath: string): string | null {
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = filePath.replace(/\\/g, "/");
  return root !== "" && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/**
 * The app set of a workspace: every Application inside the opened folder, each
 * with a session name, its workspace-relative entry, its declared ports and the
 * telo version it is edited against when the runner aligns versions.
 *
 * Names are assigned in path order, a clash taking `-2`, `-3`…, so the same
 * workspace always yields the same names. A runner takes either a version for
 * every app or for none, so an app whose version is unavailable is left out of
 * the set: its Run says why, and it joins the set once its version is known.
 */
export function desiredAppSet(
  rootDir: string,
  applications: WorkspaceApplication[],
  versioned: boolean,
): DesiredAppSet {
  const taken = new Set<string>();
  const apps: DesiredApp[] = [];
  let settled = true;
  const ordered = [...applications].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  for (const app of ordered) {
    const entryRelativePath = relativeTo(rootDir, app.filePath);
    if (entryRelativePath === null) continue;
    let telo: string | undefined;
    if (versioned) {
      if ("pending" in app.telo) settled = false;
      if (!("version" in app.telo)) continue;
      telo = app.telo.version;
    }
    const label = labelOf(app.name);
    let name = label;
    for (let n = 2; taken.has(name); n++) name = withSuffix(label, n);
    taken.add(name);
    apps.push({
      appPath: app.filePath,
      spec: {
        name,
        entryRelativePath,
        ports: app.ports,
        ...(telo !== undefined ? { telo } : {}),
      },
    });
  }
  return { apps, settled, versioned };
}

function specKey(spec: SessionAppSpec): string {
  const ports = [...(spec.ports ?? [])]
    .map((p) => `${p.protocol}/${p.port}`)
    .sort()
    .join(",");
  return `${spec.name}|${spec.entryRelativePath}|${ports}|${spec.telo ?? ""}`;
}

/** Whether two app sets would give the same pod: the same apps, entries, ports
 *  and versions, whatever their order. */
export function sameAppSet(a: SessionAppSpec[], b: SessionAppSpec[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(specKey));
  return b.every((spec) => keys.has(specKey(spec)));
}

/**
 * What to do about the app set now: nothing when the session already has it;
 * wait while an agent turn runs, because replacing the set recreates the pod and
 * would kill the agent mid-turn; apply it otherwise.
 */
export function appSetStep(
  applied: SessionAppSpec[],
  desired: SessionAppSpec[],
  turnActive: boolean,
): "none" | "wait" | "apply" {
  if (sameAppSet(applied, desired)) return "none";
  return turnActive ? "wait" : "apply";
}

/** An import or partial a module reaches outside the opened folder. */
export interface OutsideReference {
  /** The module whose manifest names it. */
  importer: string;
  /** What the manifest wrote: the import's source, or the `include:` entry. */
  source: string;
  /** Where it resolves. */
  target: string;
}

function insideRoot(rootDir: string, path: string): boolean {
  return relativeTo(rootDir, path) !== null;
}

function posixJoin(dir: string, relative: string): string {
  const segments = dir.replace(/\\/g, "/").split("/");
  for (const part of relative.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * The first file a run of `entryPath` needs from outside the opened folder, or
 * null. A session holds the opened workspace's tree and nothing above it, so
 * such a module cannot run there: Run is refused naming the import, rather than
 * started to fail on a file the session never received.
 */
export function referenceOutsideWorkspace(workspace: Workspace, entryPath: string): OutsideReference | null {
  const visited = new Set<string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const mod = workspace.modules.get(path);
    if (!mod) continue;
    const dir = path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    for (const include of mod.include ?? []) {
      const target = posixJoin(dir, include);
      if (!insideRoot(workspace.rootDir, target)) return { importer: path, source: include, target };
    }
    for (const imp of mod.imports) {
      if (imp.importKind !== "local" || !imp.resolvedPath) continue;
      if (!insideRoot(workspace.rootDir, imp.resolvedPath)) {
        return { importer: path, source: imp.source, target: imp.resolvedPath };
      }
      queue.push(imp.resolvedPath);
    }
  }
  return null;
}
