import { describe, expect, it } from "vitest";
import { applyRenames, planRenames, renameSources } from "../src/schema/plan-renames.js";
import { snapshotDeclaration } from "../src/schema/declaration-snapshot.js";
import { normalizeTable } from "../src/schema/normalize-table.js";
import type { SchemaDriver } from "../src/schema/schema-driver.js";
import type { DeclaredEnum } from "../src/schema/declared-schema.js";

/** Only the two renderers are reached from here; the rest of the seam is not
 *  consulted by rename planning. */
const driver = {
  renameTable: (_s: string, from: string, to: string) => [`RENAME TABLE ${from}->${to}`],
  renameEnum: (_s: string, from: string, to: string) => [`RENAME TYPE ${from}->${to}`],
} as unknown as SchemaDriver;

const table = (name: string, renamedFrom?: string) =>
  normalizeTable(
    { table: name, renamedFrom, columns: { id: { type: "integer" } } } as any,
    (value) => String(value),
    (value) => ({ type: String(value) }),
  );

const plan = (input: {
  tables?: ReturnType<typeof table>[];
  enums?: DeclaredEnum[];
  liveTables?: string[];
  liveEnums?: string[];
  owned?: Record<string, string>;
}) =>
  planRenames(driver, "app", {
    tables: input.tables ?? [],
    enums: input.enums ?? [],
    liveTables: new Set(input.liveTables ?? []),
    liveEnums: new Set(input.liveEnums ?? []),
    owned: input.owned ?? {},
  });

describe("planRenames", () => {
  it("renames a live, owned predecessor", () => {
    const owned = snapshotDeclaration([table("chat_messages")]);
    const result = plan({
      tables: [table("messages", "chat_messages")],
      liveTables: ["chat_messages"],
      owned,
    });
    expect(result.statements).toEqual(["RENAME TABLE chat_messages->messages"]);
    expect(result.moves).toEqual([
      { from: { kind: "table", table: "chat_messages" }, to: { kind: "table", table: "messages" } },
    ]);
    expect(result.refusals).toEqual([]);
  });

  it("is advisory: neither name present simply creates, with no statement", () => {
    const result = plan({ tables: [table("messages", "chat_messages")] });
    expect(result.statements).toEqual([]);
    expect(result.inert).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it("reports a marker whose rename has already finished everywhere", () => {
    const result = plan({
      tables: [table("messages", "chat_messages")],
      liveTables: ["messages"],
    });
    expect(result.statements).toEqual([]);
    expect(result.inert).toEqual(["table messages (renamedFrom chat_messages)"]);
  });

  it("refuses when BOTH names exist, naming both", () => {
    const owned = snapshotDeclaration([table("chat_messages")]);
    const result = plan({
      tables: [table("messages", "chat_messages")],
      liveTables: ["chat_messages", "messages"],
      owned,
    });
    expect(result.statements).toEqual([]);
    expect(result.refusals[0]?.reason).toMatch(/both 'chat_messages' and 'messages' exist/);
  });

  it("refuses a predecessor the ledger does not record as owned", () => {
    const result = plan({
      tables: [table("messages", "chat_messages")],
      liveTables: ["chat_messages"],
    });
    expect(result.statements).toEqual([]);
    expect(result.refusals[0]?.reason).toMatch(/does not record as owned/);
  });

  it("renders no statement for an enum on an engine that has none, but still moves the key", () => {
    const bare = { ...driver, renameEnum: () => [] } as unknown as SchemaDriver;
    const owned = snapshotDeclaration([], [{ typeName: "msg_role", values: ["a"] }]);
    const result = planRenames(bare, "app", {
      tables: [],
      enums: [{ typeName: "message_role", values: ["a"], renamedFrom: "msg_role" }],
      liveTables: new Set(),
      liveEnums: new Set(["msg_role"]),
      owned,
    });
    expect(result.statements).toEqual([]);
    expect(result.moves).toEqual([
      { from: { kind: "enum", table: "msg_role" }, to: { kind: "enum", table: "message_role" } },
    ]);
  });
});

describe("renameSources", () => {
  it("names every predecessor, so the caller knows what to ask the engine about", () => {
    expect(
      renameSources({
        tables: [table("messages", "chat_messages"), table("other")],
        enums: [{ typeName: "b", values: ["x"], renamedFrom: "a" }],
      }),
    ).toEqual({ tables: ["chat_messages"], enums: ["a"] });
  });
});

describe("applyRenames", () => {
  it("moves the object AND its children to the new key", () => {
    const owned = snapshotDeclaration([table("chat_messages")]);
    const moved = applyRenames(owned, [
      { from: { kind: "table", table: "chat_messages" }, to: { kind: "table", table: "messages" } },
    ]);
    expect(Object.keys(moved).sort()).toEqual(["column:messages.id", "table:messages"]);
  });

  // Two hand-written lists of "what is a child of a table" had drifted: the
  // tombstone sweep knew about checks and seed rows and this did not, so a table
  // rename left them keyed under the old name, the sweep tombstoned them on that
  // same boot, and the seed-row reclamation later failed against a table that no
  // longer exists — on every boot after it.
  it("moves a table's checks and seed rows too", () => {
    const withChildren = normalizeTable(
      {
        table: "chat_messages",
        columns: { id: { type: "integer" } },
        checks: { positive: { expression: "id > 0" } },
        seeds: { key: ["id"], rows: [{ id: 1 }] },
      } as any,
      (value) => String(value),
      (value) => ({ type: String(value) }),
    );
    const moved = applyRenames(snapshotDeclaration([withChildren]), [
      { from: { kind: "table", table: "chat_messages" }, to: { kind: "table", table: "messages" } },
    ]);
    expect(Object.keys(moved).sort()).toEqual([
      "check:messages.positive",
      "column:messages.id",
      "seedRow:messages.id=1",
      "table:messages",
    ]);
  });

  it("leaves an unrelated object alone", () => {
    const owned = snapshotDeclaration([table("chat_messages"), table("audit")]);
    const moved = applyRenames(owned, [
      { from: { kind: "table", table: "chat_messages" }, to: { kind: "table", table: "messages" } },
    ]);
    expect(Object.keys(moved)).toContain("table:audit");
    expect(Object.keys(moved)).toContain("column:audit.id");
  });

  it("is identity when nothing was renamed", () => {
    const owned = snapshotDeclaration([table("audit")]);
    expect(applyRenames(owned, [])).toBe(owned);
  });
});
