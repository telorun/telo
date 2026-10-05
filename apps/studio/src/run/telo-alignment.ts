/**
 * Whether an application ran on the telo version its run asked for.
 *
 * The runner chooses a runtime from the version — an image tag, a release
 * binary — and the runtime then says which version it is. Normally the two
 * agree; they differ when a tag was re-pushed or a mirror maps it elsewhere.
 * That is reported, never acted on: by the time the runtime speaks the manifest
 * has loaded on it, so what the user needs is to know that what they see was
 * not produced by the version they selected.
 */
export type TeloAlignment =
  /** The runtime reported the version that was asked for. */
  | { kind: "confirmed"; version: string }
  /** The runtime reported a different one. */
  | { kind: "mismatch"; requested: string; reported: string }
  /** The runtime reports no version — one released before it did. */
  | { kind: "unconfirmed"; requested: string }
  /** No version was asked for; the runner chose, and this is what it ran. */
  | { kind: "runner-chosen"; version: string };

export function teloAlignment(
  requested: string | undefined,
  reported: string | undefined,
): TeloAlignment | null {
  if (requested === undefined) {
    return reported === undefined ? null : { kind: "runner-chosen", version: reported };
  }
  if (reported === undefined) return { kind: "unconfirmed", requested };
  return reported === requested
    ? { kind: "confirmed", version: requested }
    : { kind: "mismatch", requested, reported };
}

/** The sentence behind the version shown on a run. */
export function describeTeloAlignment(alignment: TeloAlignment): string {
  switch (alignment.kind) {
    case "confirmed":
      return `Running on telo ${alignment.version}, the version this module is edited against.`;
    case "mismatch":
      return (
        `This module is edited against telo ${alignment.requested}, but the runtime the runner ` +
        `started reports telo ${alignment.reported}. What you see here was produced by ` +
        `${alignment.reported}.`
      );
    case "unconfirmed":
      return (
        `Asked to run on telo ${alignment.requested}. This runtime does not report its version, ` +
        `so that is not confirmed.`
      );
    case "runner-chosen":
      return `Running on telo ${alignment.version}, chosen by the runner: it does not align versions.`;
  }
}

/**
 * A run still going on a version its module is no longer edited against, or
 * `null`. Only a run that asked for a version can be stale, and only while it
 * is up: a finished run is history, on whatever it ran on.
 */
export function staleRunVersion(
  status: string,
  requested: string | undefined,
  edited: string | undefined,
): { running: string; edited: string } | null {
  if (requested === undefined || edited === undefined || requested === edited) return null;
  if (status !== "starting" && status !== "running" && status !== "suspended") return null;
  return { running: requested, edited };
}
