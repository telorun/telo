import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import type { NeedTable, NeedTableEntry, NeedTypeShape } from "@telorun/analyzer";
import { makeTaggedSentinel } from "@telorun/templating";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNeedParameterPaths } from "../src/need-parameter-paths.js";

/** A module already on disk: its files resolve against the manifest URL. */
const localModule = {
  getModuleArtifact: () => undefined,
  getDeclaringModule: () => undefined,
  ensureStagedEntry: () => Promise.reject(new Error("no module declares staged files here")),
};

const shape: NeedTypeShape = {
  fields: { device: { type: "string" } },
  required: ["device"],
  parameters: {
    type: "object",
    properties: { logo: { "x-telo-type": { name: "Telo.HostPath", entry: "file" } } },
  },
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "telo-need-parameter-"));
  await mkdir(path.join(dir, "assets"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function tableNaming(logo: string): NeedTable {
  const entry = {
    path: ["printer"],
    declaredBy: pathToFileURL(path.join(dir, "telo.yaml")).href,
    moduleName: "Labels",
    supply: "environment",
    fields: {},
    need: {
      name: "printer",
      kind: "Fx.LabelPrinter",
      type: "Fx.LabelPrinter",
      parameters: { logo: makeTaggedSentinel("module-path", logo) },
      optional: false,
      declaresEnv: false,
    },
  } as unknown as NeedTableEntry;
  return { entries: [entry], problems: [], environment: [] };
}

describe("a need parameter written !module-path", () => {
  // The static check reads what a source says is there; a source that cannot
  // answer leaves the refusal to the load.
  it("is refused at load when it names the other kind of entry than its parameter declares", async () => {
    await expect(resolveNeedParameterPaths(tableNaming("assets"), () => shape, localModule)).rejects.toMatchObject({
      code: "ERR_HOST_PATH_ENTRY_MISMATCH",
      message: `Need 'printer' of module 'Labels', parameters: '/logo' takes the path of a file, but '${path.join(dir, "assets")}' is a directory.`,
    });
  });
});
