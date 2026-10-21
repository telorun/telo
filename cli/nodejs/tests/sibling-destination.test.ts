import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModulePayloadBuilder } from "../src/bundle/module-payload.js";

/**
 * A `telo.yaml` is addressed by its directory, whichever way the import spells
 * it, and any other manifest by its name without the extension:
 * `./a/telo.yaml` used to publish `a` one level deeper than its directory, so
 * every relative import inside it resolved one level too deep.
 */
let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sibling-destination-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function writeModule(
  relativePath: string,
  kind: "Telo.Application" | "Telo.Library",
  name: string,
  imports: Record<string, string> = {},
): string {
  const file = path.join(workdir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const importLines = Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`);
  fs.writeFileSync(
    file,
    [
      `kind: ${kind}`,
      "metadata:",
      `  name: ${name}`,
      "  version: 1.0.0",
      ...(importLines.length ? ["imports:", ...importLines] : []),
      "",
    ].join("\n"),
  );
  return file;
}

const ROOT_DESTINATION = "oci://registry.example/acme/modules/libs/reports/billing";

describe("sibling destinations", () => {
  it("publishes a sibling imported in file form at its directory's address", async () => {
    writeModule("libs/google-workspace/telo.yaml", "Telo.Library", "GoogleWorkspace");
    writeModule("libs/reports/billing/timesheets/telo.yaml", "Telo.Library", "Timesheets", {
      Google: "../../../google-workspace/telo.yaml",
    });
    const root = writeModule("libs/reports/billing/telo.yaml", "Telo.Application", "Billing", {
      Timesheets: "./timesheets/telo.yaml",
    });

    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    const payload = await builder.payload(root, ROOT_DESTINATION);

    expect(payload.relativeImports.map((entry) => entry.ref)).toEqual([
      "oci://registry.example/acme/modules/libs/reports/billing/timesheets@1.0.0",
    ]);
    const timesheets = path.join(workdir, "libs/reports/billing/timesheets/telo.yaml");
    expect(await builder.relativeImportsOf(timesheets, `${ROOT_DESTINATION}/timesheets`)).toEqual([
      {
        manifestPath: path.join(workdir, "libs/google-workspace/telo.yaml"),
        ref: "oci://registry.example/acme/modules/libs/google-workspace",
      },
    ]);
    expect(payload.manifest).not.toContain("telo.yaml");
    expect(await builder.publishedManifest(timesheets)).toMatch(
      /Google: oci:\/\/registry\.example\/acme\/modules\/libs\/google-workspace@1\.0\.0#sha256-/,
    );
  });

  it("gives a sibling reached in file and directory form one address", async () => {
    writeModule("libs/shared/telo.yaml", "Telo.Library", "Shared");
    writeModule("app/a/telo.yaml", "Telo.Library", "A", { Shared: "../../libs/shared/telo.yaml" });
    writeModule("app/b/telo.yaml", "Telo.Library", "B", { Shared: "../../libs/shared" });
    const root = writeModule("app/telo.yaml", "Telo.Application", "App", {
      A: "./a/telo.yaml",
      B: "./b",
    });

    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    const payload = await builder.payload(root, "oci://registry.example/acme/app");

    expect(payload.relativeImports.map((entry) => entry.ref)).toEqual([
      "oci://registry.example/acme/app/a@1.0.0",
      "oci://registry.example/acme/app/b@1.0.0",
    ]);
  });

  it("reports the same refs for publish order as the manifest carries, in both forms", async () => {
    writeModule("app/a/telo.yaml", "Telo.Library", "A");
    writeModule("app/b/telo.yaml", "Telo.Library", "B");
    const root = writeModule("app/telo.yaml", "Telo.Application", "App", {
      A: "./a/telo.yaml",
      B: "./b",
    });
    const destination = "oci://registry.example/acme/app";

    const ordered = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo"),
    }).relativeImportsOf(root, destination);
    const payload = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo2"),
    }).payload(root, destination);

    expect(ordered.map((entry) => `${entry.ref}@1.0.0`)).toEqual(
      payload.relativeImports.map((entry) => entry.ref),
    );
    expect(ordered.map((entry) => entry.manifestPath)).toEqual(
      payload.relativeImports.map((entry) => entry.manifestPath),
    );
  });

  it("addresses any other manifest by its name without the extension", async () => {
    writeModule("lib/other.yaml", "Telo.Library", "Other");
    writeModule("app/schema.yaml", "Telo.Library", "Schema");
    writeModule("app/example/app.yaml", "Telo.Library", "Example");
    const root = writeModule("app/telo.yaml", "Telo.Application", "App", {
      Other: "../lib/other.yaml",
      Schema: "./schema.yaml",
      Example: "./example/app.yaml",
    });

    const payload = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo"),
    }).payload(root, "oci://registry.example/acme/app");

    expect(payload.relativeImports.map((entry) => entry.ref)).toEqual([
      "oci://registry.example/acme/lib/other@1.0.0",
      "oci://registry.example/acme/app/schema@1.0.0",
      "oci://registry.example/acme/app/example/app@1.0.0",
    ]);
  });

  it("resolves a relative import inside such a manifest as it does on disk", async () => {
    writeModule("shared/telo.yaml", "Telo.Library", "Shared");
    writeModule("libs/sibling.yaml", "Telo.Library", "Sibling");
    const app = writeModule("example/app.yaml", "Telo.Library", "Example", {
      Shared: "../shared",
      Sibling: "../libs/sibling.yaml",
    });

    expect(
      await new ModulePayloadBuilder({
        cacheRoot: path.join(workdir, ".telo"),
      }).relativeImportsOf(app, "oci://registry.example/acme/example/app"),
    ).toEqual([
      {
        manifestPath: path.join(workdir, "shared/telo.yaml"),
        ref: "oci://registry.example/acme/shared",
      },
      {
        manifestPath: path.join(workdir, "libs/sibling.yaml"),
        ref: "oci://registry.example/acme/libs/sibling",
      },
    ]);
  });

  it("refuses two manifests claiming one address", async () => {
    writeModule("app/example/app.yaml", "Telo.Library", "File");
    writeModule("app/example/app/telo.yaml", "Telo.Library", "Directory");
    const root = writeModule("app/telo.yaml", "Telo.Application", "App", {
      File: "./example/app.yaml",
      Directory: "./example/app",
    });

    await expect(
      new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") }).payload(
        root,
        "oci://registry.example/acme/app",
      ),
    ).rejects.toThrow(/are both being published to 'oci:\/\/registry\.example\/acme\/app\/example\/app'/);
  });

  it("refuses a sibling whose address is its importer's own", async () => {
    writeModule("example/app/telo.yaml", "Telo.Library", "Lib");
    const app = writeModule("example/app.yaml", "Telo.Application", "App", {
      Lib: "./app",
    });

    await expect(
      new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") }).relativeImportsOf(
        app,
        "oci://registry.example/acme/example/app",
      ),
    ).rejects.toThrow(/would both publish to one address/);
  });
});
