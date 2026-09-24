import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expandDirectoryClaims } from "../src/bundle/module-path-claims.js";

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-module-path-claims-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

it("expands a directory to every staged file beneath it as well as what is on disk", () => {
  fs.mkdirSync(path.join(workdir, "tessdata"));
  fs.writeFileSync(path.join(workdir, "tessdata/eng.traineddata.gz"), "eng");
  fs.writeFileSync(path.join(workdir, "tessdata/README"), "readme");

  const claims = expandDirectoryClaims(
    workdir,
    [{ role: "assets", path: "tessdata", origin: "!module-path at 'data'", directory: true }],
    ["tessdata/eng.traineddata.gz", "tessdata/osd.traineddata.gz", "tessdataX/other.gz"],
  );

  expect(claims.map((claim) => claim.path)).toEqual([
    "tessdata/README",
    "tessdata/eng.traineddata.gz",
    "tessdata/osd.traineddata.gz",
  ]);
});
