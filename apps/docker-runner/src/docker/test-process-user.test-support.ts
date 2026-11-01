import { DEFAULT_SESSION_USER, type SessionUser } from "@telorun/runner-core/container";

/** True where files have no owner: Windows has no uid, and Node's `chown`
 *  family succeeds there changing nothing. */
export const NO_FILE_OWNERSHIP = process.platform === "win32";

/** The test process's own user — anyone else's would need root to give a
 *  session directory to. Windows has none, so any session user is as good. */
export function testProcessUser(): SessionUser {
  if (NO_FILE_OWNERSHIP) return { ...DEFAULT_SESSION_USER };
  return { uid: process.getuid!(), gid: process.getgid!() };
}
