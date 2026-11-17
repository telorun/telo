/**
 * Whether the running single-file executable's ENTRY starts a payload as its
 * application — the one fact that makes an executable a carrier for `telo
 * package`.
 *
 * The entry declares it, because only the entry decides what a start does: an
 * executable built from another entry (a supervisor, a server) is a single-file
 * executable too, and appending a payload to it would produce a file that runs
 * that program instead of the application. A flag on the other build saying "not
 * a carrier" would have to be remembered by every bundler that ever follows.
 */
let declared = false;

/** Called once by an entry that starts a payload as the application. */
export function declareCarrierEntry(): void {
  declared = true;
}

export function isCarrierEntry(): boolean {
  return declared;
}
