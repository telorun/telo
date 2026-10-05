/** What a path holds on one side of a merge; `null` is nothing there. Two
 *  files are the same when their bytes and their mode are. */
export type PathState =
  | { kind: "file"; sha256: string; executable: boolean }
  | { kind: "symlink"; target: string }
  | null;

export type Tree = ReadonlyMap<string, PathState>;

export function sameState(a: PathState, b: PathState): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "file" && b.kind === "file") {
    return a.sha256 === b.sha256 && a.executable === b.executable;
  }
  return a.kind === "symlink" && b.kind === "symlink" && a.target === b.target;
}

export interface MergePlan {
  /** Paths only the head changed: the working tree takes the head's state. */
  takeHead: string[];
  /** Paths changed differently on both sides, deletions included. */
  conflicts: string[];
}

/**
 * Compares base, local and head per path. A path changed on one side takes
 * that side; a path both sides changed to the same thing is settled; a path
 * changed differently on both is a conflict the user settles per file. There is
 * no merge inside a file.
 */
export function planMerge(base: Tree, local: Tree, head: Tree): MergePlan {
  const takeHead: string[] = [];
  const conflicts: string[] = [];
  for (const path of new Set([...base.keys(), ...local.keys(), ...head.keys()])) {
    const b = base.get(path) ?? null;
    const l = local.get(path) ?? null;
    const h = head.get(path) ?? null;
    if (sameState(b, h) || sameState(l, h)) continue;
    if (sameState(b, l)) takeHead.push(path);
    else conflicts.push(path);
  }
  return { takeHead: takeHead.sort(), conflicts: conflicts.sort() };
}
