import { lchown, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { SessionUser } from "@telorun/runner-core/container";

import { messageOf } from "./docker-api.js";

/**
 * Give `root` and everything beneath it to the session user, changing only
 * what someone else owns: what this runner just created, and all of a session
 * whose containers ran as root under a runner from before the session user.
 * A symbolic link is re-owned itself, never followed. Run while none of the
 * session's containers exists, so nothing writes beneath `root` meanwhile.
 */
export async function giveToSessionUser(root: string, user: SessionUser): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    try {
      const stats = await lstat(path);
      if (stats.uid !== user.uid || stats.gid !== user.gid) await lchown(path, user.uid, user.gid);
      if (stats.isDirectory()) for (const entry of await readdir(path)) pending.push(join(path, entry));
    } catch (err) {
      throw new Error(`could not give ${path} to the session user ${user.uid}:${user.gid}: ${messageOf(err)}`, {
        cause: err,
      });
    }
  }
}
