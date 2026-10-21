import { describe, expect, it } from "vitest";
import { resolveNeedTable, type NeedGraph, type NeedGraphModule } from "../src/need-table.js";
import type { NeedTypeShape } from "../src/need-type.js";

function module(key: string, overrides: Partial<NeedGraphModule>): NeedGraphModule {
  return {
    key,
    name: key,
    application: false,
    shared: false,
    needs: [],
    resourceInputs: [],
    declarations: [],
    references: [],
    needTypes: [],
    otherNames: new Map(),
    imports: [],
    checked: false,
    ...overrides,
  };
}

const STORE: NeedTypeShape = {
  fields: { url: { type: "string", "x-telo-sensitive": true }, region: { type: "string" } },
  required: ["url"],
};

const need = (name: string) => ({ name, kind: "T.Store", type: "T.Store", optional: false, declaresEnv: false });

describe("the need table under a Library root", () => {
  it("lists the root's own needs and every need reaching it unsupplied as its importer's, reading no environment", () => {
    const ledger = module("ledger", { needs: [need("archive")] });
    const root = module("orders", {
      needs: [need("store")],
      imports: [
        {
          alias: "Ledger",
          manifest: { kind: "Telo.Import", metadata: { name: "Ledger" } } as never,
          target: "ledger",
          supplied: {},
        },
      ],
    });
    const graph: NeedGraph = {
      root: "orders",
      modules: new Map([
        ["orders", root],
        ["ledger", ledger],
      ]),
      needType: (kind) => (kind === "T.Store" ? STORE : undefined),
      isKind: () => true,
    };

    const table = resolveNeedTable(graph);
    const fields = {
      url: { required: true, sensitive: true },
      region: { required: false, sensitive: false },
    };
    expect(table.entries.map(({ path, supply, fields }) => ({ path, supply, fields }))).toEqual([
      { path: ["store"], supply: "importer", fields },
      { path: ["Ledger", "archive"], supply: "importer", fields },
    ]);
    expect(table.environment).toEqual([]);
  });
});
