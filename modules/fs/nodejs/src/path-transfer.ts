import { InvokeError } from "@telorun/sdk";
import { link, lstat, mkdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { wrapFsError } from "./fs-support.js";

/** The directory realpath of `p`'s parent joined with its base name: the place
 *  `p` physically is, without following `p` itself when it is a link. The
 *  deepest existing ancestor is resolved and the absent rest appended. */
async function physicalPath(p: string): Promise<string> {
  const rest: string[] = [path.basename(p)];
  let current = path.dirname(p);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw err;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Refuse, before anything changes, a transfer whose source is absent, whose
 *  destination lies inside the source (or is it), or whose destination exists. */
export async function assertTransferable(
  kind: string,
  source: string,
  destination: string,
  intoItselfCode: "ERR_MOVE_INTO_ITSELF" | "ERR_COPY_INTO_ITSELF",
): Promise<void> {
  try {
    await lstat(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InvokeError("ERR_PATH_NOT_FOUND", `${kind}: '${source}' does not exist.`, {
        path: source,
      });
    }
    throw wrapFsError(`${kind}: cannot read`, source, err);
  }

  let from: string;
  let to: string;
  try {
    from = await physicalPath(source);
    to = await physicalPath(destination);
  } catch (err) {
    throw wrapFsError(`${kind}: cannot resolve`, destination, err);
  }
  if (to === from || to.startsWith(from + path.sep)) {
    throw new InvokeError(
      intoItselfCode,
      `${kind}: destination '${destination}' is inside the source '${source}'.`,
      { path: source, destination },
    );
  }

  let taken: boolean;
  try {
    taken = await exists(destination);
  } catch (err) {
    throw wrapFsError(`${kind}: cannot read`, destination, err);
  }
  if (taken) {
    throw new InvokeError("ERR_PATH_EXISTS", `${kind}: '${destination}' already exists.`, {
      path: destination,
    });
  }
}

/** Create the missing parent directories of `destination`. Returns an undo that
 *  removes exactly the directories this call created, deepest first. */
export async function makeParents(destination: string): Promise<() => Promise<void>> {
  const parent = path.dirname(destination);
  const first = await mkdir(parent, { recursive: true });
  return async () => {
    if (first === undefined) return;
    let dir = parent;
    for (;;) {
      try {
        await rmdir(dir);
      } catch (err) {
        // A directory someone else has since filled is theirs to keep.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "ENOENT") throw err;
      }
      if (dir === first) return;
      dir = path.dirname(dir);
    }
  };
}

export async function removeQuietly(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

const TAKEN = new Set(["EEXIST", "ENOTEMPTY"]);
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"]);

function taken(kind: string, destination: string): InvokeError {
  return new InvokeError("ERR_PATH_EXISTS", `${kind}: '${destination}' already exists.`, {
    path: destination,
  });
}

/** Put `source` at the absent `destination` and take it from `source`. A regular
 *  file is hard-linked and then unlinked, so a destination that appeared since
 *  the check is refused rather than replaced; a directory is renamed, which
 *  replaces an empty directory or a file created in that window (Node has no
 *  no-replace rename). Other failures are thrown as they came. */
export async function placeNew(kind: string, source: string, destination: string): Promise<void> {
  if ((await lstat(source)).isFile()) {
    try {
      await link(source, destination);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (TAKEN.has(code)) throw taken(kind, destination);
      if (!LINK_UNSUPPORTED.has(code)) throw err;
      return renameNew(kind, source, destination);
    }
    try {
      await unlink(source);
    } catch (err) {
      throw await withCleanup(err as Error, () => unlink(destination));
    }
    return;
  }
  await renameNew(kind, source, destination);
}

async function renameNew(kind: string, source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (err) {
    if (TAKEN.has((err as NodeJS.ErrnoException).code ?? "")) throw taken(kind, destination);
    throw err;
  }
}

/** Run every cleanup; return `error` itself, with whatever the cleanups threw
 *  attached as `cleanupFailure` and named in its message, never in its place. */
export async function withCleanup<E extends Error>(
  error: E,
  ...cleanups: Array<() => Promise<void>>
): Promise<E> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    const failure = failures.length === 1 ? failures[0] : new AggregateError(failures, "cleanup failed");
    const reason = failure instanceof Error ? failure.message : String(failure);
    error.message += ` (cleanup also failed: ${reason})`;
    Object.assign(error, { cleanupFailure: failure });
  }
  return error;
}
