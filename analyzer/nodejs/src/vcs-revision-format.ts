/** The Node checker for the `vcs-revision` Telo format: a full commit id, 40
 *  (SHA-1) or 64 (SHA-256) lower-case hexadecimal digits. Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

const REASON =
  "a revision is a full commit id of 40 (SHA-1) or 64 (SHA-256) lower-case hexadecimal digits; " +
  "a tag, a branch or an abbreviated id is not accepted";

function checkVcsRevision(value: string): TeloFormatFailure | undefined {
  const bad = value.search(/[^0-9a-f]/);
  if (bad !== -1) return { reason: REASON, offset: bad };
  if (value.length !== 40 && value.length !== 64) {
    return { reason: `${REASON} (this one has ${value.length})`, offset: Math.min(value.length, 40) };
  }
  return undefined;
}

export const vcsRevisionChecker: TeloFormatChecker = { check: checkVcsRevision };
