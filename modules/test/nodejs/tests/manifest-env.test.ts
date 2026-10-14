import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect, it } from "vitest";
import { buildEnvForManifest } from "../src/suite.js";

it("gives the suite's env precedence over the forwarded host env and the env files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-suite-env-"));
  fs.writeFileSync(path.join(dir, ".env"), "PROBE=file\nFILE_ONLY=file\n");
  const env = buildEnvForManifest(
    path.join(dir, "case.yaml"),
    { PROBE: "host", HOST_ONLY: "host" },
    { PROBE: "suite" },
  );
  expect(env).toMatchObject({ PROBE: "suite", FILE_ONLY: "file", HOST_ONLY: "host" });
});
