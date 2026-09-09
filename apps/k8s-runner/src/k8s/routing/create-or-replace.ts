import { isConflict } from "../pod-status.js";

/** A create that yields to an existing object of the same name. Every routing
 *  object is republished on reload (an app's declared port set changes), so the
 *  write has to be idempotent rather than create-once. */
export async function createOrReplace(
  create: () => Promise<unknown>,
  replace: () => Promise<unknown>,
): Promise<void> {
  try {
    await create();
  } catch (err) {
    if (!isConflict(err)) throw err;
    await replace();
  }
}
