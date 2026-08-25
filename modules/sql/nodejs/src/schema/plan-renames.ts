import type { DeclaredEnum, DeclaredTable, SchemaObjectId } from "./declared-schema.js";
import { describeObject, isTableChild, objectKey } from "./declared-schema.js";
import type { DeclarationSnapshot } from "./declaration-snapshot.js";
import { parseObjectKey } from "./declaration-snapshot.js";
import type { Refusal } from "./schema-reconciler.js";
import type { SchemaDriver } from "./schema-driver.js";

/**
 * Renaming a top-level object — a table, an enum type.
 *
 * **Unlike a column, this is a NATIVE rename, and the difference is not an
 * oversight.** A column rename is expand-contract — add, copy, tombstone —
 * because both names can coexist while the previous version of the app is still
 * running. A table has no cheap equivalent: copying every row is unbounded work,
 * and writes during the overlap would land in one table and not the other, so
 * the two diverge. So the rename is immediate, and the cost is stated where an
 * author reads it: between the rename and the new deployment, an instance still
 * running the previous version does not find the table.
 *
 * **The marker is not optional sugar.** The reconciler cannot tell a rename from
 * a drop-and-create, and the wrong guess is expensive in both directions: for a
 * table it creates an empty one and tombstones the populated original, and for a
 * type it alters every column that uses it — a table rewrite each.
 *
 * **Advisory, so a missing predecessor is not an error.** Neither name present is
 * a fresh database (or a marker left in place long after the fact) and the object
 * is simply created. Predecessor present and successor absent is the rename
 * itself. **Both present refuses**, naming both: that is either a half-finished
 * earlier run or an object created independently, and those want opposite
 * repairs, which is why an occupied destination is refused rather than guessed
 * at. A predecessor the ledger does not record as OWNED refuses too — the same
 * ownership that decides what may be reclaimed decides what may be renamed.
 */
export interface RenamePlan {
  readonly statements: readonly string[];
  /** What each rename did, for the log. */
  readonly describes: readonly string[];
  /** Ledger keys to move. A rename rewrites the entry from the old key to the
   *  new one: tombstoning the old and creating the new would record a
   *  drop-and-create even though the database did the cheap thing, and the next
   *  boot would see an object awaiting reclamation. */
  readonly moves: readonly { readonly from: SchemaObjectId; readonly to: SchemaObjectId }[];
  /** Markers that can no longer do anything — the successor is there and the
   *  predecessor is gone, so the rename has finished everywhere and the mention
   *  is dead manifest text. */
  readonly inert: readonly string[];
  readonly refusals: readonly Refusal[];
}

export interface RenameInput {
  readonly tables: readonly DeclaredTable[];
  readonly enums: readonly DeclaredEnum[];
  /** Physical names present in the namespace right now. */
  readonly liveTables: ReadonlySet<string>;
  readonly liveEnums: ReadonlySet<string>;
  readonly owned: DeclarationSnapshot;
}

/** Every predecessor name a declaration mentions, so the caller knows what to
 *  ask the engine about beyond what it declares. */
export function renameSources(input: {
  readonly tables: readonly DeclaredTable[];
  readonly enums: readonly DeclaredEnum[];
}): { readonly tables: string[]; readonly enums: string[] } {
  return {
    tables: input.tables.map((table) => table.renamedFrom).filter((n): n is string => !!n),
    enums: input.enums.map((one) => one.renamedFrom).filter((n): n is string => !!n),
  };
}

export function planRenames(
  driver: SchemaDriver,
  schema: string,
  input: RenameInput,
): RenamePlan {
  const statements: string[] = [];
  const describes: string[] = [];
  const moves: { from: SchemaObjectId; to: SchemaObjectId }[] = [];
  const inert: string[] = [];
  const refusals: Refusal[] = [];

  const consider = (
    kind: "table" | "enum",
    from: string,
    to: string,
    live: ReadonlySet<string>,
    render: () => string[],
  ): void => {
    const target: SchemaObjectId = { kind, table: to };
    const source: SchemaObjectId = { kind, table: from };

    if (live.has(from) && live.has(to)) {
      refusals.push({
        object: describeObject(target),
        reason:
          `renames from '${from}', but both '${from}' and '${to}' exist. That is either a ` +
          `half-finished earlier run or an object created independently, and those want ` +
          `opposite repairs — drop whichever is not wanted, or remove the marker.`,
      });
      return;
    }
    if (!live.has(from)) {
      // Neither present is a fresh database and the object is simply created.
      // Successor present and predecessor gone means the rename has already
      // happened everywhere: the marker is dead text, and saying so is the only
      // way its author learns it can go.
      if (live.has(to)) inert.push(`${describeObject(target)} (renamedFrom ${from})`);
      return;
    }
    if (input.owned[objectKey(source)] === undefined) {
      refusals.push({
        object: describeObject(target),
        reason:
          `renames from '${from}', which this schema's ledger does not record as owned. The ` +
          `same ownership that decides what may be reclaimed decides what may be renamed — ` +
          `adopt it first, or drop the marker and rename by hand.`,
      });
      return;
    }
    statements.push(...render());
    describes.push(`${describeObject(source)} → ${to}`);
    moves.push({ from: source, to: target });
  };

  for (const table of input.tables) {
    if (!table.renamedFrom) continue;
    consider("table", table.renamedFrom, table.name, input.liveTables, () =>
      driver.renameTable(schema, table.renamedFrom!, table.name),
    );
  }
  for (const declared of input.enums) {
    if (!declared.renamedFrom) continue;
    // An engine whose constraints never named the type renders NOTHING here —
    // the ledger key rewrite IS the rename. The move is still recorded, which is
    // what makes that true rather than merely claimed.
    consider("enum", declared.renamedFrom, declared.typeName, input.liveEnums, () =>
      driver.renameEnum(schema, declared.renamedFrom!, declared.typeName),
    );
  }

  return { statements, describes, moves, inert, refusals };
}

/**
 * The snapshot with a renamed object's entries moved to their new key — the
 * object itself and, for a table, every child keyed under it.
 *
 * Returns a new snapshot; the caller's is untouched. Nothing is written to the
 * ledger by this: the version row is composed fresh from the current declaration
 * on every pass, so moving the OWNED reading is the whole rewrite — the
 * reconciler then reads the new name as already owned and does not tombstone the
 * old one.
 */
export function applyRenames(
  owned: DeclarationSnapshot,
  moves: readonly { readonly from: SchemaObjectId; readonly to: SchemaObjectId }[],
): DeclarationSnapshot {
  if (moves.length === 0) return owned;
  let current = owned;
  for (const move of moves) {
    const next: DeclarationSnapshot = {};
    const fromKey = objectKey(move.from);
    for (const [key, definition] of Object.entries(current)) {
      if (key === fromKey) {
        next[objectKey(move.to)] = definition;
        continue;
      }
      const id = parseObjectKey(key);
      // Through the shared predicate: this list and the reconciler's tombstone
      // sweep are the same question, and when they were two hand-written lists
      // only one of them learned about checks and seed rows.
      const child =
        move.from.kind === "table" && id.table === move.from.table && isTableChild(id.kind);
      next[child ? objectKey({ ...id, table: move.to.table }) : key] = definition;
    }
    current = next;
  }
  return current;
}
