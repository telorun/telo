import { describeReason, describeRemedy, type IncompatibilityReason } from "@telorun/ide-support";

/** The sentence for imports that are behind with nothing offerable.
 *
 *  A remedy is only stated when every entry shares one cause. A mixed set has
 *  two different answers — update telo for one, wait for a republish for the
 *  other — and printing the first entry's would be wrong for the rest, which is
 *  the same invented-cause mistake the four verdicts exist to prevent. */
export function blockedMessage(
  blocked: Array<{ name: string; version: string; reason: IncompatibilityReason }>,
): string {
  // Nothing held back is nothing to say. Answered here rather than left to each
  // caller's guard: reading `blocked[0]` out of an empty list is a throw, and a
  // sentence about no imports has no subject.
  if (blocked.length === 0) return "";
  const uniform = blocked.every((b) => b.reason === blocked[0].reason) ? blocked[0].reason : null;
  const head =
    blocked.length === 1
      ? `A newer version of ${blocked[0].name} (${blocked[0].version}) is published, but ${describeReason(blocked[0].reason)}.`
      : `Newer versions of ${blocked.map((b) => b.name).join(", ")} are published that this telo cannot use.`;
  return uniform
    ? `${head} ${describeRemedy(uniform)}`
    : `${head} Hover each import for what is holding it back.`;
}

/** The "Outdated" badge's tooltip. A reason is only ever printed when one was
 *  established: the three states are "behind and upgradeable", "behind, with a
 *  newer version held back", and "behind with nothing offerable", and the last
 *  two are exactly the ones that carry a cause. */
export function outdatedTitle(
  newest: string | null | undefined,
  offering: string | undefined,
  heldBack: { version: string; reason: IncompatibilityReason } | null,
): string {
  if (!heldBack) return `Latest is ${newest}`;
  const cause = `${heldBack.version} held back because ${describeReason(heldBack.reason)}`;
  return offering ? `${cause} — offering ${offering}` : cause;
}

/** The one-click upgrade's tooltip: what it will do, plus what it is NOT doing
 *  when something newer exists that this telo cannot host. */
export function upgradeActionTitle(
  name: string,
  toVersion: string,
  heldBack: { version: string; reason: IncompatibilityReason } | null | undefined,
): string {
  return heldBack
    ? `Upgrade ${name} to ${toVersion} — ${heldBack.version} is newer but ${describeReason(heldBack.reason)}`
    : `Upgrade ${name} to ${toVersion}`;
}

/** The version picker's tooltip, which is the only control left on a row whose
 *  newer version is held back — so it is where that cause has to be said. */
export function versionPickerTitle(
  name: string,
  currentVersion: string,
  heldBack: { version: string; reason: IncompatibilityReason } | null | undefined,
): string {
  return heldBack
    ? `${heldBack.version} is published but ${describeReason(heldBack.reason)} — choose a version for ${name} (current ${currentVersion})`
    : `Choose a version for ${name} (current ${currentVersion})`;
}
