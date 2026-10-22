import { describe, expect, it } from "vitest";
import { BUILTIN_DOCUMENT_FILES } from "../src/builtin-entries/index.js";
import { directorySizeBytes, DURABLE_DIRECTORY_TYPE } from "../src/durable-directory.js";
import {
  resolveNeedTable,
  type NeedGraph,
  type NeedGraphImport,
  type NeedGraphModule,
  type NeedGraphNeed,
} from "../src/need-table.js";
import { needParametersWithDefaults, readNeedTypeShape } from "../src/need-type.js";

const SHAPE = readNeedTypeShape(BUILTIN_DOCUMENT_FILES.find(([file]) => file === "DurableDirectory.json")![1]);

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

const directory = (name: string, parameters?: Record<string, unknown>): NeedGraphNeed => ({
  name,
  kind: DURABLE_DIRECTORY_TYPE,
  type: DURABLE_DIRECTORY_TYPE,
  optional: false,
  declaresEnv: false,
  ...(parameters ? { parameters } : {}),
});

const ref = (name: string) => ({ __tagged: true, engine: "ref", source: name });

const imported = (alias: string, target: string, supplied: Record<string, unknown>): NeedGraphImport => ({
  alias,
  manifest: { kind: "Telo.Import", metadata: { name: alias } } as never,
  target,
  supplied,
});

/** An application forwarding its own `uploads` need to libraries. */
function table(own: Record<string, unknown> | undefined, libraries: Record<string, NeedGraphModule>, imports: NeedGraphImport[]) {
  const root = module("app", { application: true, needs: [directory("uploads", own)], imports });
  const graph: NeedGraph = {
    root: "app",
    modules: new Map([["app", root], ...Object.entries(libraries)]),
    needType: (kind) => (kind === DURABLE_DIRECTORY_TYPE ? SHAPE : undefined),
    isKind: () => true,
  };
  return resolveNeedTable(graph).problems.map((p) => ({ code: p.code, message: p.message }));
}

describe("the durable directory type's parameters", () => {
  it("fills size and access from the type's defaults", () => {
    expect(needParametersWithDefaults(SHAPE, undefined)).toEqual({ size: "1Gi", access: "single-writer" });
    expect(needParametersWithDefaults(SHAPE, { size: "5Gi" })).toEqual({ size: "5Gi", access: "single-writer" });
  });

  it("reads a size in bytes, refusing one in another unit", () => {
    expect(directorySizeBytes("512Mi")).toBe(512n << 20n);
    expect(directorySizeBytes("1Ti")).toBe(1n << 40n);
    expect(directorySizeBytes("5GB")).toBeUndefined();
  });

  it("refuses a size outside the type's grammar as NEED_PARAMETERS_INVALID", () => {
    const problems = table({ size: "5GB" }, {}, []);
    expect(problems.map((p) => p.code)).toEqual(["NEED_PARAMETERS_INVALID"]);
  });
});

describe("a durable directory forwarded whole", () => {
  const library = (name: string, parameters?: Record<string, unknown>) =>
    module(name, { needs: [directory("files", parameters)] });

  it("refuses a shared directory supplying a single-writer need", () => {
    const problems = table({ access: "shared" }, { lib: library("lib") }, [
      imported("Lib", "lib", { files: ref("uploads") }),
    ]);
    expect(problems).toEqual([
      expect.objectContaining({ code: "NEED_FORWARD_INCOMPATIBLE", message: expect.stringContaining("'shared'") }),
    ]);
  });

  it("accepts a single-writer directory supplying a shared need", () => {
    expect(table(undefined, { lib: library("lib", { access: "shared" }) }, [imported("Lib", "lib", { files: ref("uploads") })])).toEqual([]);
  });

  it("refuses a smaller directory supplying a larger need, defaults included", () => {
    const problems = table(undefined, { lib: library("lib", { size: "5Gi" }) }, [
      imported("Lib", "lib", { files: ref("uploads") }),
    ]);
    expect(problems).toEqual([
      expect.objectContaining({
        code: "NEED_FORWARD_INCOMPATIBLE",
        message: expect.stringContaining("asks for 'size: 5Gi', and the need supplying it asks for only '1Gi'"),
      }),
    ]);
  });

  it("refuses one directory forwarded to two needs, naming every target", () => {
    const problems = table(undefined, { a: library("a"), b: library("b") }, [
      imported("A", "a", { files: ref("uploads") }),
      imported("B", "b", { files: ref("uploads") }),
    ]);
    expect(problems).toEqual([
      {
        code: "NEED_DIRECTORY_FORWARDED_TWICE",
        message: expect.stringContaining("forwarded whole to 2 needs — 'A.files', 'B.files'"),
      },
    ]);
  });

  it("counts a shared library's need once however many imports reach it", () => {
    const shared = module("lib", { shared: true, needs: [directory("files")] });
    expect(
      table(undefined, { lib: shared }, [
        imported("A", "lib", { files: ref("uploads") }),
        imported("B", "lib", { files: ref("uploads") }),
      ]),
    ).toEqual([]);
  });
});
