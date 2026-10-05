import type { MarkedVersion } from "@telorun/language-host";

/** How many minor releases the version menu lists. Telo ships a minor often and
 *  every one stays published, so an unbounded menu only grows. */
export const VERSION_MENU_MINORS = 10;

export interface VersionMenuRow {
  mark: MarkedVersion;
  /** An earlier patch of the minor release listed just above it. */
  nested: boolean;
}

/**
 * The rows of the telo version menu: the newest minor releases, each as its
 * newest version with that minor's other versions nested beneath it.
 *
 * `versions` arrives newest first. A minor release is `major.minor`; its other
 * versions are its earlier patches, and an unreleased build of the same number.
 * The minor holding `selected` is always listed, however old — a menu that does
 * not show the current choice reads as that choice being gone.
 */
export function versionMenuRows(
  versions: readonly MarkedVersion[],
  selected: string | undefined,
  minors: number = VERSION_MENU_MINORS,
): VersionMenuRow[] {
  const byMinor = new Map<string, MarkedVersion[]>();
  for (const mark of versions) {
    const minor = minorOf(mark.version);
    const group = byMinor.get(minor);
    if (group) group.push(mark);
    else byMinor.set(minor, [mark]);
  }
  const selectedMinor = selected === undefined ? undefined : minorOf(selected);
  return [...byMinor.entries()]
    .filter(([minor], index) => index < minors || minor === selectedMinor)
    .flatMap(([, group]) => group.map((mark, index) => ({ mark, nested: index > 0 })));
}

/** `0.103` of `0.103.2`; a version in no such shape is a minor of its own. */
function minorOf(version: string): string {
  return /^(\d+\.\d+)\./.exec(version)?.[1] ?? version;
}
