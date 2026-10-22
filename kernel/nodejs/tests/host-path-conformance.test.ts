import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { refuseMisplacedHostEntries, refuseRelativeHostPaths } from "../src/host-paths.js";

const VECTORS = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../analyzer/host-path-conformance/vectors.json"),
    "utf8",
  ),
) as {
  schema: Record<string, any>;
  rows: Array<{ id: string; value: unknown; code: string | null; message: string | null }>;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-host-path-"));
const places: Record<string, string> = {
  file: path.join(scratch, "file"),
  directory: path.join(scratch, "directory"),
  absent: path.join(scratch, "absent"),
  unreadable: path.join(scratch, "a".repeat(300)),
};
fs.writeFileSync(places.file!, "x");
fs.mkdirSync(places.directory!);
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PLACEHOLDER = /\{(file|directory|absent|unreadable)\}/g;
const placed = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => places[name]!);
/** The same inside JSON text, where a Windows path's backslashes must be escaped. */
const placedInJson = (text: string) =>
  text.replace(PLACEHOLDER, (_, name: string) => JSON.stringify(places[name]!).slice(1, -1));
/** Windows reports an over-long name as absent, so it has no `{unreadable}` path to give. */
const unplaceable = (row: { value: unknown }) =>
  process.platform === "win32" && JSON.stringify(row.value).includes("{unreadable}");

describe("host-path conformance vectors", () => {
  for (const row of VECTORS.rows) {
    it.skipIf(unplaceable(row))(row.id, () => {
      const resource = JSON.parse(placedInJson(JSON.stringify(row.value))) as Record<string, unknown>;
      // The order the kernel checks a resource in at creation.
      const create = () => {
        refuseMisplacedHostEntries(resource, VECTORS.schema, "App.Store/store");
        refuseRelativeHostPaths(resource, VECTORS.schema, "App.Store/store");
      };
      if (row.code === null) {
        expect(create).not.toThrow();
        return;
      }
      // `{reason}` is the operating system's own words, which each runtime reports its own way.
      const [before, after = ""] = `App.Store/store: ${placed(row.message!)}`.split("{reason}");
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const message = row.message!.includes("{reason}")
        ? expect.stringMatching(new RegExp(`^${escape(before!)}.+${escape(after)}$`))
        : `App.Store/store: ${placed(row.message!)}`;
      expect(create).toThrow(expect.objectContaining({ code: row.code, message }));
    });
  }
});
