import { describe, expect, it } from "vitest";
import { normalizeTable } from "../src/schema/normalize-table.js";

/** These declarations name their targets by plain string, so the resolver has
 *  nothing to resolve. Resolution itself is covered in `table-reference.test.ts`. */
const byName = (value: unknown) => String(value);

/** A backend whose column types are all storage classes. The enum path is
 *  covered in `enum-reference.test.ts`. */
const asStorageClass = (value: unknown) => ({ type: String(value) });

/**
 * Declaration-level refusals. Each of these is decidable from the manifest
 * alone, so it is refused where it is written rather than reaching the engine
 * as SQL the author never saw.
 */
describe("normalizeTable", () => {
  const table = (columns: Record<string, any>, rest: Record<string, any> = {}) =>
    normalizeTable({ table: "users", columns, ...rest } as any, byName, asStorageClass);

  it("defaults nullability to true and leaves flags off", () => {
    const declared = table({ id: { type: "integer" } });
    expect(declared.columns[0]).toMatchObject({
      name: "id",
      type: "integer",
      nullable: true,
      array: false,
      primaryKey: false,
      unique: false,
    });
  });

  it("carries unknown fields through as type parameters", () => {
    const declared = table({ name: { type: "varchar", length: 64, collation: "C" } });
    expect(declared.columns[0]?.params).toEqual({ length: 64, collation: "C" });
  });

  it("refuses a table with no columns", () => {
    expect(() => table({})).toThrow(/declares no columns/);
  });

  it("refuses two primary keys, which no per-column flag can express", () => {
    expect(() =>
      table({ a: { type: "integer", primaryKey: true }, b: { type: "integer", primaryKey: true } }),
    ).toThrow(/composite primary key/);
  });

  it("refuses a literal default beside a SQL default expression", () => {
    expect(() =>
      table({ a: { type: "text", default: "x", defaultExpression: "now()" } }),
    ).toThrow(/exactly one may be set/);
  });

  it("refuses a column renamed from itself", () => {
    expect(() => table({ a: { type: "text", renamedFrom: "a" } })).toThrow(/renamedFrom itself/);
  });

  it("refuses a rename whose source the table still declares", () => {
    expect(() =>
      table({ old: { type: "text" }, fresh: { type: "text", renamedFrom: "old" } }),
    ).toThrow(/also declares/);
  });

  it("refuses an index over a column the table does not declare", () => {
    expect(() =>
      table({ a: { type: "text" } }, { indexes: { byB: { columns: ["b"] } } }),
    ).toThrow(/names column 'b'/);
  });

  it("refuses a foreign key over a column the table does not declare", () => {
    expect(() =>
      table(
        { a: { type: "text" } },
        { foreignKeys: { fk: { columns: ["b"], references: { table: "other", columns: ["id"] } } } },
      ),
    ).toThrow(/names column 'b'/);
  });

  it("refuses a foreign key whose sides have different arity", () => {
    expect(() =>
      table(
        { a: { type: "text" }, b: { type: "text" } },
        {
          foreignKeys: {
            fk: { columns: ["a", "b"], references: { table: "other", columns: ["id"] } },
          },
        },
      ),
    ).toThrow(/one for one/);
  });

  it("takes a reference's table from the resolver, whatever the slot holds", () => {
    const declared = normalizeTable(
      {
        table: "users",
        columns: { a: { type: "text" } },
        foreignKeys: {
          fk: { columns: ["a"], references: { table: { kind: "X.Table", name: "o" }, columns: ["id"] } },
        },
      } as any,
      () => "other",
      asStorageClass,
    );
    expect(declared.foreignKeys[0]?.references.table).toBe("other");
  });
});

/**
 * A constraint the engine applies whether or not the declaration mentions it.
 * Left implicit, the live column reads back NOT NULL, the pass sees a difference
 * it can "fix", and every boot after the first tries to drop NOT NULL from a
 * primary key.
 */
describe("implied non-nullability", () => {
  const table = (columns: Record<string, any>) =>
    normalizeTable({ table: "users", columns } as any, byName, asStorageClass);

  it("makes a primary key non-nullable even when nothing says so", () => {
    expect(table({ id: { type: "integer", primaryKey: true } }).columns[0]?.nullable).toBe(false);
  });

  it("makes an identity column non-nullable", () => {
    expect(
      table({ id: { type: "integer", primaryKey: true, identity: "always" } }).columns[0]?.nullable,
    ).toBe(false);
  });

  it("refuses a declaration that states the opposite", () => {
    expect(() => table({ id: { type: "integer", primaryKey: true, nullable: true } })).toThrow(
      /cannot hold NULL/,
    );
  });

  it("leaves an ordinary column's nullability alone", () => {
    expect(table({ a: { type: "text" } }).columns[0]?.nullable).toBe(true);
    expect(table({ a: { type: "text", nullable: false } }).columns[0]?.nullable).toBe(false);
  });
});
