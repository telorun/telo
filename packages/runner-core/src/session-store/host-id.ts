import { generateSessionId } from "../session/session-id.js";

/** Draws an id for a session or a share. */
export type MintId = () => string;

export const DEFAULT_MINT_ID: MintId = generateSessionId;

/** How many ids are drawn before a collision with the namespace is the
 *  caller's error. */
export const MAX_ID_DRAWS = 3;

/** Every id drawn collided with one the namespace already holds, or released. */
export class HostIdCollisionError extends Error {
  constructor(draws: number) {
    super(
      `${draws} ids drawn in a row were already held or released in the host-id namespace; ` +
        "the store cannot mint an id",
    );
  }
}
