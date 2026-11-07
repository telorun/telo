import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(here, "../../../modules/run");

/** A `Telo.Import` declared in a `with:` scope: the graph walk reaches it like an
 *  `imports:` entry, so the load refuses its target before anything boots,
 *  located at the member inside its holder. */
function appYaml(source: string): string {
  return `kind: Telo.Application
metadata:
  name: ScopedImport
  version: 1.0.0
imports:
  Run: ${RUN}
targets:
  - !ref seq
---
kind: Run.Sequence
metadata:
  name: seq
with:
  - kind: Telo.Import
    metadata:
      name: Inner
    source: ${source}
steps:
  - name: noop
    value: 1
`;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function runScopedImport(source: string, files: Record<string, string>): Promise<unknown> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-scoped-import-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, appYaml(source));
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  try {
    await kernel.load(appPath);
  } catch (error) {
    return error;
  }
  await kernel.teardown();
  throw new Error("the scoped import was not refused at load");
}

/** The load failure's diagnostic, located at the member inside its holder. */
function importEntry(error: unknown): unknown {
  const [diagnostic] = (error as { diagnostics?: unknown[] }).diagnostics ?? [];
  return { code: (error as { code?: unknown }).code, diagnostic };
}

const AT_MEMBER = { origin: expect.objectContaining({ resource: { kind: "Run.Sequence", name: "seq" }, path: "with[0]" }) };

describe("a scoped import whose source names no module", () => {
  it("refuses a source that does not resolve as ERR_IMPORT_UNRESOLVED", async () => {
    const error = await runScopedImport("./nope.yaml", {});
    expect(importEntry(error)).toMatchObject({
      code: "ERR_IMPORT_UNRESOLVED",
      diagnostic: { code: "IMPORT_UNRESOLVED", ...AT_MEMBER },
    });
  });

  it("refuses a source that is no module reference as ERR_INVALID_IMPORT_SOURCE", async () => {
    const error = await runScopedImport('"foo bar baz"', {});
    expect(importEntry(error)).toMatchObject({
      code: "ERR_INVALID_IMPORT_SOURCE",
      diagnostic: { code: "INVALID_IMPORT_SOURCE", ...AT_MEMBER },
    });
  });
});

describe("a scoped import of a target that is not a library", () => {
  it("refuses an application target as ERR_INVALID_IMPORT_TARGET, in the loader's words", async () => {
    const error = await runScopedImport("./other-app.yaml", {
      "other-app.yaml": "kind: Telo.Application\nmetadata:\n  name: OtherApp\n",
    });
    expect(importEntry(error)).toMatchObject({
      code: "ERR_INVALID_IMPORT_TARGET",
      diagnostic: {
        code: "INVALID_IMPORT_TARGET",
        message:
          "Cannot use import 'Inner' → './other-app.yaml': Telo.Import target './other-app.yaml' is a " +
          "Telo.Application. Only Telo.Library modules may be imported. Applications are run directly, " +
          "not imported. Point this import at a library, or drop it and run that application on its own.",
        ...AT_MEMBER,
      },
    });
  });

  it("refuses a target with no library document as ERR_INVALID_IMPORT_TARGET", async () => {
    const error = await runScopedImport("./not-a-module.yaml", {
      "not-a-module.yaml": "kind: Telo.JsonSchema\nmetadata:\n  name: Thing\nschema:\n  type: string\n",
    });
    expect(importEntry(error)).toMatchObject({
      code: "ERR_INVALID_IMPORT_TARGET",
      diagnostic: {
        code: "INVALID_IMPORT_TARGET",
        message: expect.stringContaining(
          "Telo.Import target './not-a-module.yaml' did not resolve to a Telo.Library.",
        ),
        ...AT_MEMBER,
      },
    });
  });

  it("refuses a library named with a reserved kind prefix as ERR_KIND_PREFIX_RESERVED", async () => {
    const error = await runScopedImport("./self-lib.yaml", {
      "self-lib.yaml": "kind: Telo.Library\nmetadata:\n  name: Self\n  version: 1.0.0\n",
    });
    expect(importEntry(error)).toMatchObject({
      code: "ERR_KIND_PREFIX_RESERVED",
      diagnostic: {
        code: "KIND_PREFIX_RESERVED",
        message: expect.stringContaining("'./self-lib.yaml' is a Telo.Library named 'Self'"),
        ...AT_MEMBER,
      },
    });
  });
});
