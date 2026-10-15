import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import {
  constraintObservations,
  type NeedGraph,
  type NeedGraphModule,
} from "../src/need-table.js";

const ref = (name: string): unknown => makeTaggedSentinel("ref", name);

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
    checked: true,
    ...overrides,
  };
}

describe("the constraint-reachability walk", () => {
  it("walks each declaring module once, however many imports reach it", () => {
    let walked = 0;
    const library = module("orders", {
      needs: [{ name: "access", kind: "T.Access", type: "T.Access", optional: false, declaresEnv: false }],
      references: [
        {
          declaration: { name: "db", kind: "T.Db", manifest: { kind: "T.Db", metadata: { name: "db" } } as never },
          path: "access",
          target: { name: "access" },
          observes: ["version"],
        },
      ],
    });
    const imports = library.imports;
    Object.defineProperty(library, "imports", {
      get: () => {
        walked += 1;
        return imports;
      },
    });
    const root = module("app", {
      application: true,
      needs: [{ name: "access", kind: "T.Access", type: "T.Access", optional: false, declaresEnv: false }],
      imports: Array.from({ length: 100 }, (_, i) => ({
        alias: `Orders${i}`,
        manifest: { kind: "Telo.Import", metadata: { name: `Orders${i}` } } as never,
        target: "orders",
        supplied: { access: ref("access") },
      })),
    });
    const graph: NeedGraph = {
      root: "app",
      modules: new Map([
        ["app", root],
        ["orders", library],
      ]),
      needType: () => undefined,
      isKind: () => true,
    };
    const observed = constraintObservations(graph)("app");
    expect([...(observed.get("access") ?? [])]).toEqual(["version"]);
    expect(walked).toBe(1);
  });
});
