/**
 * The paths the env-file walk speaks in: absolute, `/`-separated, rooted at `/`,
 * `X:/` or `//host/share/`. One spelling for every host — the CLI converts a
 * native path at its boundary, the browser already has this one — so a parent,
 * a join and a workspace-relative display are computed here once rather than by
 * each host with its own `path` module.
 *
 * A path names no `.` or `..` segment and ends in no `/` unless it is a root.
 */

const UNC_ROOT = /^\/\/[^/]+\/[^/]+(?:\/|$)/;
const DRIVE_ROOT = /^[A-Za-z]:\//;

/** The root prefix of an absolute path, always ending in `/`, or `undefined`
 *  for a path that is not absolute in this spelling. */
function rootOf(path: string): string | undefined {
  const unc = UNC_ROOT.exec(path);
  if (unc) return unc[0].endsWith("/") ? unc[0] : `${unc[0]}/`;
  const drive = DRIVE_ROOT.exec(path);
  if (drive) return drive[0];
  return path.startsWith("/") && !path.startsWith("//") ? "/" : undefined;
}

/** `path` in canonical form, or a throw naming why it is not one: a relative
 *  path or a `.` / `..` segment is a caller's error, never something to guess at. */
export function workspacePath(path: string): string {
  const root = rootOf(path);
  if (root === undefined) {
    throw new Error(`'${path}' is not an absolute '/'-separated path (rooted at '/', 'X:/' or '//host/share/').`);
  }
  const rest = path.slice(Math.min(root.length, path.length)).split("/").filter((segment) => segment !== "");
  if (rest.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`'${path}' holds a '.' or '..' segment; pass the path it resolves to.`);
  }
  return root + rest.join("/");
}

/** The directory holding `path`, or `undefined` for a root. */
export function workspacePathParent(path: string): string | undefined {
  const root = rootOf(path)!;
  if (path.length <= root.length) return undefined;
  const cut = path.lastIndexOf("/");
  return cut < root.length ? root : path.slice(0, cut);
}

/** `name` — one segment — inside directory `directory`. */
export function workspacePathJoin(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * `to` relative to the directory `from`, `/`-separated, `''` when they are the
 * same, climbing with `..` where `to` is not beneath `from`. Two paths under
 * different roots have no relative form, and `to` comes back as it is.
 */
export function workspacePathRelative(from: string, to: string): string {
  const fromRoot = rootOf(from);
  if (fromRoot === undefined || fromRoot !== rootOf(to)) return to;
  const segments = (path: string) => path.slice(fromRoot.length).split("/").filter((s) => s !== "");
  const a = segments(from);
  const b = segments(to);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return [...a.slice(shared).map(() => ".."), ...b.slice(shared)].join("/");
}

/** Whether `path` is `directory` or lies beneath it. */
export function isWithinWorkspacePath(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith("/") ? directory : `${directory}/`);
}
