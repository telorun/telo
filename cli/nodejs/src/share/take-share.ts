import type { Logger } from "../logger.js";
import { outErrLine } from "../output.js";
import { prepareShare, type ShareOptions, type ShareSession } from "./share-session.js";
import { ShareRefusal } from "./share-refusal.js";

/** Prints a share refusal as `error <code>: <message>` and its hints beneath. */
export function printShareRefusal(refusal: ShareRefusal, log: Logger): void {
  for (const line of refusal.lines(log.err.error("error"))) outErrLine(line);
}

/**
 * Takes the share a `telo run --share` needs, before its kernel is built, and
 * puts the share's two templates into the environment as the host values the
 * kernel answers every `Telo.PublicUrl` from. `"refused"` once the refusal is
 * printed and `process.exitCode` set.
 */
export async function takeShare(options: ShareOptions): Promise<ShareSession | "refused"> {
  try {
    const session = await prepareShare(options);
    if (!session) {
      process.exitCode ||= 1;
      return "refused";
    }
    for (const [name, value] of Object.entries(session.hostValues())) process.env[name] = value;
    return session;
  } catch (error) {
    if (!(error instanceof ShareRefusal)) throw error;
    printShareRefusal(error, options.log);
    process.exitCode = 1;
    return "refused";
  }
}
