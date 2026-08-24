import { describe, expect, it } from "vitest";
import type { ApplicationManifest, LibraryManifest } from "../../../model";
import {
  bindingNameError,
  bindingChips,
  exportCandidates,
  exportChips,
  freshBindingName,
  withBinding,
  withExport,
  withoutBinding,
  withoutExport,
} from "./module-declarations";

describe("binding blocks", () => {
  const fields = {
    variables: {
      dbConnection: { env: "DB_CONNECTION", type: "string" },
      trackLoop: { env: "TRACK_LOOP", type: "boolean" },
    },
  };

  it("lists entries with the env var they bind", () => {
    expect(bindingChips(fields, "variables")).toEqual([
      { name: "dbConnection", detail: "DB_CONNECTION" },
      { name: "trackLoop", detail: "TRACK_LOOP" },
    ]);
  });

  it("shows no detail where nothing is bound — a library's variables bind nothing", () => {
    expect(bindingChips({ variables: { region: { type: "string" } } }, "variables")).toEqual([
      { name: "region" },
    ]);
  });

  it("reads an absent block as empty rather than throwing", () => {
    expect(bindingChips({}, "ports")).toEqual([]);
    expect(bindingChips({ ports: "nonsense" }, "ports")).toEqual([]);
  });

  it("numbers a fresh name off the ones already taken", () => {
    expect(freshBindingName(fields, "variables", "newVariable")).toBe("newVariable");
    expect(freshBindingName({ variables: { newVariable: {} } }, "variables", "newVariable")).toBe(
      "newVariable2",
    );
    expect(
      freshBindingName({ variables: { newVariable: {}, newVariable2: {} } }, "variables", "newVariable"),
    ).toBe("newVariable3");
  });

  it("adds an entry carrying only what its schema requires", () => {
    expect(withBinding({}, "variables", "region", true).variables).toEqual({
      region: { env: "", type: "string" },
    });
    // A library binds no host env, so there is no `env` to write.
    expect(withBinding({}, "variables", "region", false).variables).toEqual({
      region: { type: "string" },
    });
    // A port's value is implicitly an integer — no `type:` to declare.
    expect(withBinding({}, "ports", "http", true).ports).toEqual({ http: { env: "" } });
  });

  it("rejects a name no CEL expression could read", () => {
    // `db-connection` parses as subtraction, `in` is a keyword — the analyzer's
    // rule, not a pattern restated here.
    expect(bindingNameError(fields, "variables", "dbConnection", "db-connection")).toBeDefined();
    expect(bindingNameError(fields, "variables", "dbConnection", "in")).toBeDefined();
    expect(bindingNameError(fields, "variables", "dbConnection", "")).toBeDefined();
  });

  it("rejects a name already taken, and allows a no-op", () => {
    expect(bindingNameError(fields, "variables", "dbConnection", "trackLoop")).toBeDefined();
    expect(bindingNameError(fields, "variables", "dbConnection", "dbConnection")).toBeUndefined();
  });

  it("allows a PascalCase name — that tier is a warning in telo check too", () => {
    expect(bindingNameError(fields, "variables", "dbConnection", "DbConnection")).toBeUndefined();
  });

  it("removes an entry without disturbing its siblings", () => {
    expect(withoutBinding(fields, "variables", "trackLoop").variables).toEqual({
      dbConnection: { env: "DB_CONNECTION", type: "string" },
    });
  });

  it("drops the block with its last entry rather than leaving a null key", () => {
    // Left as `{}`, the diff deletes only the last child and the key survives
    // with no value — which reparses as `null`, not as an empty map.
    const one = { variables: { only: { env: "X", type: "string" } } };
    expect(withoutBinding(one, "variables", "only")).toEqual({});
    expect("variables" in withoutBinding(one, "variables", "only")).toBe(false);
  });
});

describe("exports", () => {
  const fields = { exports: { kinds: ["Store", "Cache.Entry"], resources: ["writeLine"] } };

  it("lists the importable name and keeps a re-export's origin as the detail", () => {
    expect(exportChips(fields, "kinds")).toEqual([
      { name: "Store" },
      { name: "Entry", detail: "Cache.Entry" },
    ]);
  });

  it("adds and removes names, leaving order to the author", () => {
    expect(withExport(fields, "resources", "reader").exports).toMatchObject({
      resources: ["writeLine", "reader"],
    });
    expect(withExport(fields, "kinds", "Store")).toBe(fields);
    expect(withoutExport(fields, "kinds", "Store").exports).toMatchObject({
      kinds: ["Cache.Entry"],
    });
  });

  it("keeps an emptied list rather than dropping the key", () => {
    // An ABSENT `exports.kinds` means ungated — every kind importable — so
    // removing the last entry must narrow the surface, not widen it.
    const one = { exports: { kinds: ["Store"] } };
    expect(withoutExport(one, "kinds", "Store").exports).toEqual({ kinds: [] });
  });
});

describe("exportCandidates", () => {
  function library(): LibraryManifest {
    return {
      kind: "Library",
      filePath: "/lib/telo.yaml",
      metadata: { name: "lib" },
      imports: [],
      resources: [
        { kind: "Telo.Definition", name: "Store", fields: {} },
        { kind: "Telo.Abstract", name: "Connection", fields: {} },
        { kind: "Telo.Import", name: "Cache", fields: {} },
        { kind: "Self.Store", name: "store", fields: {} },
        { kind: "Demo.Writer", name: "writeLine", fields: {} },
      ],
    };
  }

  it("offers the module's own kinds, minus what is already exported", () => {
    expect(exportCandidates(library(), {}, "kinds")).toEqual(["Store", "Connection"]);
    expect(exportCandidates(library(), { exports: { kinds: ["Store"] } }, "kinds")).toEqual([
      "Connection",
    ]);
  });

  it("offers instances by excluding framework docs, not by listing doc kinds", () => {
    // Every framework doc is namespaced under `Telo.`, so nothing here has to
    // know that `Telo.Import` exists.
    expect(exportCandidates(library(), {}, "resources")).toEqual(["store", "writeLine"]);
  });

  it("works the same for an Application, which simply exports nothing", () => {
    const app: ApplicationManifest = {
      kind: "Application",
      filePath: "/app/telo.yaml",
      metadata: { name: "app" },
      imports: [],
      targets: [],
      resources: [{ kind: "Demo.Job", name: "job", fields: {} }],
    };
    expect(exportCandidates(app, {}, "resources")).toEqual(["job"]);
  });
});
