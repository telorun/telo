import { describe, expect, it } from "vitest";
import { planReconciliation } from "../src/schema/schema-reconciler.js";
import { snapshotDeclaration, snapshotDigest } from "../src/schema/declaration-snapshot.js";
import { normalizeTable } from "../src/schema/normalize-table.js";
import type {
  ChangeSafety,
  LiveColumn,
  LiveEnum,
  LiveTable,
  SchemaDriver,
} from "../src/schema/schema-driver.js";
import type { DeclaredEnum } from "../src/schema/declared-schema.js";

/**
 * A driver that renders a statement per operation and treats a type change as
 * unsafe — the conservative engine. Enough to pin what the SHARED half decides,
 * which is everything about what gets created, held and dropped.
 */
function driver(overrides: Partial<SchemaDriver> = {}): SchemaDriver {
  const base: SchemaDriver = {
    connection: {} as never,
    quote: (n) => `"${n}"`,
    qualify: (s, t) => `"${s}"."${t}"`,
    withLock: (_s, body) => body(),
    ensureNamespaceStatements: () => [],
    ledgerStatements: () => [],
    runAtomically: async () => {},
    introspect: async () => [],
    typeSignature: (c) => c.type,
    classifyAlter: (live, declared): ChangeSafety =>
      live.typeSignature === declared.type
        ? { safe: true }
        : { safe: false, reason: "type change" },
    classifyIndexChange: (): ChangeSafety => ({ safe: true }),
    classifyForeignKeyChange: (): ChangeSafety => ({ safe: true }),
    foreignKeysInCreateTable: false,
    namesForeignKeys: true,
    classifyCopy: (live, target): ChangeSafety =>
      live.typeSignature === target.type ? { safe: true } : { safe: false, reason: "copy" },
    canReclaim: () => ({ safe: true }),
    runSequentially: async () => {},
    namedEnumTypes: true,
    introspectEnums: async () => [],
    createEnum: (_s, e) => [`CREATE TYPE ${e.typeName}`],
    addEnumValues: (_s, e, values) => values.map((v) => `ADD VALUE ${e.typeName}.${v}`),
    renameEnum: (_s, from, to) => [`RENAME TYPE ${from}->${to}`],
    renameTable: (_s, from, to) => [`RENAME TABLE ${from}->${to}`],
    classifyEnumChange: (): ChangeSafety => ({ safe: true }),
    dropEnum: (_s, n) => [`DROP TYPE ${n}`],
    namedExtensions: true,
    introspectExtensions: async () => [],
    createExtension: (_s, n) => [`CREATE EXTENSION ${n}`],
    dropExtension: (_s, n) => [`DROP EXTENSION ${n}`],
    checksInCreateTable: false,
    checkDiffers: (live, declared) => live.expression !== declared.expression,
    classifyCheckChange: (): ChangeSafety => ({ safe: true }),
    addCheck: (_s, t, c) => [`ADD CHECK ${t}.${c.name}`],
    dropCheck: (_s, t, n) => [`DROP CHECK ${t}.${n}`],
    validateCheck: (_s, t, n) => [`VALIDATE ${t}.${n}`],
    createTable: (_s, t) => [`CREATE ${t.name}`],
    addColumn: (_s, t, c) => [`ADD ${t}.${c.name}`],
    alterColumn: (_s, t, _l, c) => [`ALTER ${t}.${c.name}`],
    copyColumn: (_s, t, from, to) => [`COPY ${t}.${from}->${to}`],
    createIndex: (_s, _t, i) => [`INDEX ${i.name}`],
    dropIndex: (_s, _t, i) => [`DROP INDEX ${i}`],
    addForeignKey: (_s, _t, f) => [`FK ${f.name}`],
    dropForeignKey: (_s, _t, n) => [`DROP FK ${n}`],
    dropColumn: (_s, t, c) => [`DROP ${t}.${c}`],
    dropTable: (_s, t) => [`DROP TABLE ${t}`],
  };
  return { ...base, ...overrides };
}

const users = (columns: Record<string, any>, rest: Record<string, any> = {}) =>
  normalizeTable({ table: "users", columns, ...rest } as any, (value) => String(value), (value) => ({
    type: String(value),
  }));

const live = (columns: LiveColumn[], rest: Partial<LiveTable> = {}): LiveTable => ({
  name: "users",
  columns,
  indexes: [],
  foreignKeys: [],
  checks: [],
  ...rest,
});

const column = (name: string, type = "text", over: Partial<LiveColumn> = {}): LiveColumn => ({
  name,
  typeSignature: type,
  nullable: true,
  hasDefault: false,
  primaryKey: false,
  unique: false,
  ...over,
});

const plan = (
  declared: ReturnType<typeof users>[],
  liveTables: LiveTable[],
  owned: Record<string, string> = {},
  tombstoned = new Set<string>(),
  d = driver(),
  enums: DeclaredEnum[] = [],
  liveEnums: LiveEnum[] = [],
) =>
  planReconciliation(d, "app", {
    tables: declared,
    enums,
    extensions: [],
    live: liveTables,
    liveEnums,
    liveExtensions: [],
    owned,
    tombstoned,
  });

describe("planReconciliation", () => {
  it("creates a table that is not there", () => {
    const result = plan([users({ id: { type: "integer" } })], []);
    expect(result.statements.map((s) => s.sql)).toEqual(["CREATE users"]);
    expect(result.tombstones).toEqual([]);
  });

  it("adds only the columns that are missing", () => {
    const result = plan([users({ id: { type: "integer" }, email: { type: "text" } })], [
      live([column("id", "integer")]),
    ]);
    expect(result.statements.map((s) => s.sql)).toEqual(["ADD users.email"]);
  });

  it("emits nothing when the live shape already matches", () => {
    const result = plan([users({ id: { type: "integer" } })], [live([column("id", "integer")])]);
    expect(result.statements).toEqual([]);
  });

  it("orders cross-table constraints after tables and indexes", () => {
    const declared = users(
      { id: { type: "integer" }, other: { type: "integer" } },
      {
        indexes: { byOther: { columns: ["other"] } },
        foreignKeys: {
          fk: { columns: ["other"], references: { table: "other", columns: ["id"] } },
        },
      },
    );
    expect(plan([declared], []).statements.map((s) => s.phase)).toEqual([
      "table",
      "index",
      "constraint",
    ]);
  });

  // Ownership — the property that makes adopting an existing database safe.
  it("never tombstones an object it has never declared", () => {
    const result = plan([users({ id: { type: "integer" } })], [
      live([column("id", "integer"), column("legacy")], {
        indexes: [{ name: "legacyIdx", columns: ["legacy"], unique: false }],
      }),
    ]);
    expect(result.tombstones).toEqual([]);
    expect(result.statements).toEqual([]);
  });

  it("tombstones a previously declared column, and emits no DDL for it", () => {
    const owned = snapshotDeclaration([users({ id: { type: "integer" }, gone: { type: "text" } })]);
    const result = plan([users({ id: { type: "integer" } })], [
      live([column("id", "integer"), column("gone")]),
    ], owned);
    expect(result.tombstones.map((t) => t.key)).toEqual(["column:users.gone"]);
    expect(result.statements).toEqual([]);
  });

  it("keeps a tombstone's last-known definition", () => {
    const owned = snapshotDeclaration([users({ id: { type: "integer" }, gone: { type: "text" } })]);
    const result = plan([users({ id: { type: "integer" } })], [live([column("id", "integer")])], owned);
    expect(JSON.parse(result.tombstones[0]!.definition)).toMatchObject({ name: "gone", type: "text" });
  });

  it("does not tombstone twice while one is outstanding", () => {
    const owned = snapshotDeclaration([users({ id: { type: "integer" }, gone: { type: "text" } })]);
    const result = plan(
      [users({ id: { type: "integer" } })],
      [live([column("id", "integer"), column("gone")])],
      owned,
      new Set(["column:users.gone"]),
    );
    expect(result.tombstones).toEqual([]);
  });

  it("revives a tombstone when the column is declared again", () => {
    const owned = snapshotDeclaration([users({ id: { type: "integer" }, back: { type: "text" } })]);
    const result = plan(
      [users({ id: { type: "integer" }, back: { type: "text" } })],
      [live([column("id", "integer"), column("back")])],
      owned,
      new Set(["column:users.back"]),
    );
    expect(result.revived).toEqual(["column:users.back"]);
    expect(result.tombstones).toEqual([]);
  });

  it("tombstones a dropped table WITHOUT its children — the DROP TABLE takes them", () => {
    // Recording the children too would plan a drop for each, and dependents are
    // dropped before their table — so an engine that refuses to drop a primary
    // key or an indexed column (SQLite refuses both) would fail the pass, and go
    // on failing it, over objects the DROP TABLE was about to remove anyway.
    const owned = snapshotDeclaration([
      users(
        { id: { type: "integer", primaryKey: true }, other: { type: "integer" } },
        { indexes: { byOther: { columns: ["other"] } } },
      ),
    ]);
    const result = plan([], [], owned);
    expect(result.tombstones.map((t) => t.key)).toEqual(["table:users"]);
  });

  it("still tombstones a column when its table stays", () => {
    const owned = snapshotDeclaration([
      users({ id: { type: "integer", primaryKey: true }, gone: { type: "text" } }),
    ]);
    const result = plan(
      [users({ id: { type: "integer", primaryKey: true } })],
      [live([column("id", "integer", { nullable: false })])],
      owned,
    );
    expect(result.tombstones.map((t) => t.key)).toEqual(["column:users.gone"]);
  });

  // Renames.
  it("adds, copies and tombstones the source", () => {
    const owned = snapshotDeclaration([users({ id: { type: "integer" }, old: { type: "text" } })]);
    const result = plan(
      [users({ id: { type: "integer" }, fresh: { type: "text", renamedFrom: "old" } })],
      [live([column("id", "integer"), column("old")])],
      owned,
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ADD users.fresh", "COPY users.old->fresh"]);
    expect(result.tombstones.map((t) => t.key)).toEqual(["column:users.old"]);
  });

  it("refuses a rename that changes the type, before any statement", () => {
    const result = plan(
      [users({ id: { type: "integer" }, fresh: { type: "integer", renamedFrom: "old" } })],
      [live([column("id", "integer"), column("old", "text")])],
    );
    expect(result.refusals).toHaveLength(1);
    expect(result.statements).toEqual([]);
  });

  it("reports a rename whose source is gone as inert, and does not re-tombstone it", () => {
    const result = plan(
      [users({ id: { type: "integer" }, fresh: { type: "text", renamedFrom: "reclaimed" } })],
      [live([column("id", "integer"), column("fresh")])],
    );
    expect(result.inertRenames).toEqual(["column users.fresh (renamedFrom reclaimed)"]);
    expect(result.tombstones).toEqual([]);
  });

  it("does not call a rename inert on a table it is creating", () => {
    const result = plan([users({ id: { type: "integer" }, fresh: { type: "text", renamedFrom: "old" } })], []);
    expect(result.inertRenames).toEqual([]);
  });

  it("does not copy from a source that is not there", () => {
    const result = plan(
      [users({ id: { type: "integer" }, fresh: { type: "text", renamedFrom: "old" } })],
      [live([column("id", "integer")])],
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ADD users.fresh"]);
  });

  // Alterations.
  it("refuses an unsafe alteration and plans nothing for it", () => {
    const result = plan(
      [users({ id: { type: "integer" } })],
      [live([column("id", "text")])],
    );
    expect(result.refusals[0]).toMatchObject({ object: "users.id", reason: "type change" });
    expect(result.statements).toEqual([]);
  });

  it("applies an alteration the engine calls safe", () => {
    const result = plan(
      [users({ id: { type: "integer" } })],
      [live([column("id", "text")])],
      {},
      new Set(),
      driver({ classifyAlter: () => ({ safe: true }) }),
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ALTER users.id"]);
  });

  it("notices a default that appeared or vanished", () => {
    const result = plan(
      [users({ id: { type: "integer", default: 1 } })],
      [live([column("id", "integer")])],
      {},
      new Set(),
      driver({ classifyAlter: () => ({ safe: true }) }),
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ALTER users.id"]);
  });
});

describe("snapshotDigest", () => {
  it("is independent of declaration order", () => {
    const a = snapshotDeclaration([users({ a: { type: "text" }, b: { type: "text" } })]);
    const b = snapshotDeclaration([users({ b: { type: "text" }, a: { type: "text" } })]);
    expect(snapshotDigest(a)).toBe(snapshotDigest(b));
  });

  it("moves when a column's type changes", () => {
    const a = snapshotDeclaration([users({ a: { type: "text" } })]);
    const b = snapshotDeclaration([users({ a: { type: "integer" } })]);
    expect(snapshotDigest(a)).not.toBe(snapshotDigest(b));
  });
});

/**
 * Drift the pass used to be blind to.
 *
 * Columns were compared on type, nullability and the presence of a default;
 * indexes and foreign keys were matched by NAME alone. So adding `unique: true`,
 * changing which columns an index covers, or changing a foreign key's delete
 * rule emitted nothing and reported nothing — while the ledger recorded the new
 * definition as owned, leaving the manifest asserting something the database was
 * not doing.
 */
/**
 * An engine that keeps no constraint name — SQLite — matches a declaration to a
 * live key by what that key maps to. Every case here is a boot AFTER the one
 * that created the table, which is the only time the question is asked.
 */
describe("foreign keys on an engine that keeps no name", () => {
  const unnamed = (over: Partial<SchemaDriver> = {}) =>
    driver({ foreignKeysInCreateTable: true, namesForeignKeys: false, ...over });

  const declaring = (keys: Record<string, any>) =>
    users({ userId: { type: "integer" } }, { foreignKeys: keys });

  const column: LiveColumn = {
    name: "userId",
    typeSignature: "integer",
    nullable: true,
    hasDefault: false,
    primaryKey: false,
    unique: false,
  };

  const liveKey = (name: string, over: Record<string, any> = {}) => ({
    name,
    columns: ["userId"],
    references: { table: "other", columns: ["id"] },
    ...over,
  });

  const one = { columns: ["userId"], references: { table: "other", columns: ["id"] } };

  it("recognises its own key under a name the engine never kept", () => {
    const result = plan(
      [declaring({ fk: one })],
      [live([column], { foreignKeys: [liveKey("sqlite_fk_0")] })],
      {},
      new Set(),
      unnamed(),
    );
    expect(result.statements.map((s) => s.sql)).toEqual([]);
  });

  it("pairs two identical keys one for one instead of both taking the first", () => {
    const result = plan(
      [declaring({ a: one, b: one })],
      [live([column], { foreignKeys: [liveKey("sqlite_fk_0"), liveKey("sqlite_fk_1")] })],
      {},
      new Set(),
      unnamed(),
    );
    expect(result.statements.map((s) => s.sql)).toEqual([]);
  });

  it("reports a key genuinely absent rather than letting its twin stand in", () => {
    const result = plan(
      [declaring({ a: one, b: one })],
      [live([column], { foreignKeys: [liveKey("sqlite_fk_0")] })],
      {},
      new Set(),
      unnamed(),
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["FK b"]);
  });

  it("treats a changed delete rule as a change to that key, never as a new one", () => {
    const result = plan(
      [declaring({ fk: { ...one, onDelete: "cascade" } })],
      [live([column], { foreignKeys: [liveKey("sqlite_fk_0", { onDelete: "NO ACTION" })] })],
      {},
      new Set(),
      unnamed({ classifyForeignKeyChange: () => ({ safe: false, reason: "no ALTER" }) }),
    );
    expect(result.statements).toEqual([]);
    expect(result.refusals.map((r) => r.reason)).toEqual(["no ALTER"]);
  });

  it("does not re-add the keys of a table it just created", () => {
    const result = plan([declaring({ fk: one })], [], {}, new Set(), unnamed());
    expect(result.statements.map((s) => s.sql)).toEqual(["CREATE users"]);
  });
});

describe("constraint and definition drift", () => {
  const permissive = driver({
    classifyAlter: () => ({ safe: true }),
    classifyIndexChange: () => ({ safe: true }),
    classifyForeignKeyChange: () => ({ safe: true }),
  });

  it("notices uniqueness appearing on an existing column", () => {
    const result = plan(
      [users({ email: { type: "text", unique: true } })],
      [live([column("email")])],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ALTER users.email"]);
  });

  it("notices a column joining or leaving the primary key", () => {
    const result = plan(
      [users({ id: { type: "integer", primaryKey: true } })],
      [live([column("id", "integer", { nullable: false })])],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["ALTER users.id"]);
  });

  it("refuses a constraint change the engine cannot make in place", () => {
    const result = plan(
      [users({ email: { type: "text", unique: true } })],
      [live([column("email")])],
      {},
      new Set(),
      driver({ classifyAlter: () => ({ safe: false, reason: "named constraint" }) }),
    );
    expect(result.refusals[0]).toMatchObject({ object: "users.email", reason: "named constraint" });
    expect(result.statements).toEqual([]);
  });

  it("rebuilds an index whose columns changed", () => {
    const declared = users(
      { a: { type: "text" }, b: { type: "text" } },
      { indexes: { byBoth: { columns: ["a", "b"] } } },
    );
    const result = plan(
      [declared],
      [live([column("a"), column("b")], {
        indexes: [{ name: "byBoth", columns: ["a"], unique: false }],
      })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["DROP INDEX byBoth", "INDEX byBoth"]);
  });

  it("treats column ORDER as part of an index", () => {
    const declared = users(
      { a: { type: "text" }, b: { type: "text" } },
      { indexes: { byBoth: { columns: ["a", "b"] } } },
    );
    const result = plan(
      [declared],
      [live([column("a"), column("b")], {
        indexes: [{ name: "byBoth", columns: ["b", "a"], unique: false }],
      })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements).toHaveLength(2);
  });

  it("notices an index becoming unique", () => {
    const declared = users(
      { a: { type: "text" } },
      { indexes: { byA: { columns: ["a"], unique: true } } },
    );
    const result = plan(
      [declared],
      [live([column("a")], { indexes: [{ name: "byA", columns: ["a"], unique: false }] })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements).toHaveLength(2);
  });

  it("leaves an index that already matches alone", () => {
    const declared = users(
      { a: { type: "text" } },
      { indexes: { byA: { columns: ["a"] } } },
    );
    const result = plan(
      [declared],
      [live([column("a")], { indexes: [{ name: "byA", columns: ["a"], unique: false }] })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements).toEqual([]);
  });

  it("notices a foreign key's delete rule changing", () => {
    const declared = users(
      { userId: { type: "text" } },
      {
        foreignKeys: {
          fk: {
            columns: ["userId"],
            references: { table: "other", columns: ["id"] },
            onDelete: "cascade",
          },
        },
      },
    );
    const result = plan(
      [declared],
      [live([column("userId")], {
        foreignKeys: [
          {
            name: "fk",
            columns: ["userId"],
            references: { table: "other", columns: ["id"] },
            onDelete: "NO ACTION",
          },
        ],
      })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements.map((s) => s.sql)).toEqual(["DROP FK fk", "FK fk"]);
  });

  it("treats a declaration that states no action as NO ACTION", () => {
    const declared = users(
      { userId: { type: "text" } },
      { foreignKeys: { fk: { columns: ["userId"], references: { table: "other", columns: ["id"] } } } },
    );
    const result = plan(
      [declared],
      [live([column("userId")], {
        foreignKeys: [
          {
            name: "fk",
            columns: ["userId"],
            references: { table: "other", columns: ["id"] },
            onDelete: "NO ACTION",
          },
        ],
      })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements).toEqual([]);
  });

  it("does not invent a difference from an action the engine did not report", () => {
    const declared = users(
      { userId: { type: "text" } },
      {
        foreignKeys: {
          fk: {
            columns: ["userId"],
            references: { table: "other", columns: ["id"] },
            onDelete: "cascade",
          },
        },
      },
    );
    const result = plan(
      [declared],
      [live([column("userId")], {
        foreignKeys: [
          { name: "fk", columns: ["userId"], references: { table: "other", columns: ["id"] } },
        ],
      })],
      {},
      new Set(),
      permissive,
    );
    expect(result.statements).toEqual([]);
  });
});

/**
 * Enums. The shared half decides ownership, ordering and what a removal means;
 * the rendering is the driver's, and the two engines answer `namedEnumTypes`
 * differently — which is what these pin.
 */
describe("planReconciliation — enums", () => {
  const role: DeclaredEnum = { typeName: "role", values: ["admin", "viewer"] };

  it("creates an absent type, in the phase that runs ahead of the tables", () => {
    const result = plan([], [], {}, new Set(), driver(), [role]);
    expect(result.statements).toEqual([
      { phase: "enum", sql: "CREATE TYPE role", describes: "enum role" },
    ]);
  });

  it("adds a value in its OWN phase — it cannot be used in the transaction that adds it", () => {
    const result = plan([], [], {}, new Set(), driver(), [
      { typeName: "role", values: ["admin", "viewer", "auditor"] },
    ], [{ name: "role", values: ["admin", "viewer"] }]);
    expect(result.statements).toEqual([
      { phase: "enumValue", sql: "ADD VALUE role.auditor", describes: "enum role" },
    ]);
  });

  it("records a removed value and emits nothing — no engine can drop one", () => {
    const result = plan([], [], {}, new Set(), driver(), [
      { typeName: "role", values: ["admin"] },
    ], [{ name: "role", values: ["admin", "viewer"] }]);
    expect(result.statements).toEqual([]);
    expect(result.retainedEnumValues).toEqual(["role.viewer"]);
  });

  it("plans nothing at all where the engine has no named types", () => {
    const unnamed = driver({ namedEnumTypes: false });
    const result = plan([], [], {}, new Set(), unnamed, [role]);
    expect(result.statements).toEqual([]);
  });

  it("refuses a change the driver cannot make, with its reason", () => {
    const unnamed = driver({
      namedEnumTypes: false,
      classifyEnumChange: () => ({ safe: false, reason: "rebuild the referencing tables" }),
    });
    const owned = snapshotDeclaration([], [{ typeName: "role", values: ["admin"] }]);
    const result = plan([], [], owned, new Set(), unnamed, [role]);
    expect(result.refusals).toEqual([
      { object: "enum role", reason: "rebuild the referencing tables" },
    ]);
  });

  it("tombstones a type the declaration no longer lists", () => {
    const owned = snapshotDeclaration([], [role]);
    const result = plan([], [], owned, new Set(), driver(), []);
    expect(result.tombstones.map((t) => t.key)).toEqual(["enum:role"]);
  });

  it("does not suppress an enum sharing a retired table's name", () => {
    // `table` carries a top-level object's own physical name, so an enum and a
    // table can collide there — and a retired table must take only its own
    // children with it.
    const owned = snapshotDeclaration([users({ id: { type: "integer" } })], [
      { typeName: "users", values: ["a"] },
    ]);
    const result = plan([], [], owned, new Set(), driver(), []);
    expect(result.tombstones.map((t) => t.key).sort()).toEqual(["enum:users", "table:users"]);
  });
});
