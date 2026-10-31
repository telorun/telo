import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `telo needs report`, end to end: what an operator provisions from, computed
 *  from the manifest with nothing booted. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args].map(quote), {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.status ?? 1 };
  }
}

const field = (env: string, envSource: string, required: boolean, sensitive: boolean) => ({
  env,
  envSource,
  required,
  sensitive,
});

describe("telo needs report", () => {
  it("lists every need read from the environment, by the name each field is read from", () => {
    const fixture = path.join(ROOT, "cli/nodejs/tests/__fixtures__/needs-report");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      reportVersion: 1,
      dimensions: [],
      needs: [
        {
          path: "sessionKey",
          declaredBy: "./",
          type: { module: "./types", name: "SigningKey" },
          version: null,
          features: [],
          parameters: {},
          optional: false,
          required: true,
          fields: { value: field("SESSION_KEY", "bound", true, true) },
        },
        {
          path: "audit",
          declaredBy: "./",
          type: { module: "./types", name: "DatabaseAccess" },
          version: null,
          features: [],
          parameters: {},
          optional: true,
          required: false,
          fields: {
            url: field("TELO_NEED_AUDIT__URL", "derived", true, true),
            schema: field("TELO_NEED_AUDIT__SCHEMA", "derived", false, false),
          },
        },
        {
          path: "Orders.databaseAccess",
          declaredBy: "./orders",
          type: { module: "./types", name: "DatabaseAccess" },
          version: null,
          features: [],
          parameters: { extensions: ["pgvector"] },
          optional: false,
          required: true,
          fields: {
            url: field("TELO_NEED_ORDERS__DATABASE_ACCESS__URL", "derived", true, true),
            schema: field("TELO_NEED_ORDERS__DATABASE_ACCESS__SCHEMA", "derived", false, false),
          },
        },
      ],
    });
  });

  it("lists the version range and features a need states", () => {
    const fixture = path.join(ROOT, "tests/__fixtures__/needs/env/observed.yaml");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).needs).toEqual([
      {
        path: "databaseAccess",
        declaredBy: "./observed.yaml",
        type: { module: "./../consume/kinds", name: "DatabaseAccess" },
        version: ">=16.1.0",
        features: ["pgvector"],
        parameters: {},
        optional: false,
        required: true,
        fields: { url: field("CONSUME_DATABASE_URL", "bound", true, true) },
      },
    ]);
  });

  it("lists the dimensions a need's requirement is keyed by, and the configurations requiring it", () => {
    const fixture = path.join(ROOT, "tests/__fixtures__/configurations/needs/database.yaml");
    const json = runCli(["needs", "report", "-o", "json", fixture]);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.dimensions).toEqual([
      { key: "resources.databaseAccess", values: ["present", "absent"], env: ["DATABASE_URL"] },
    ]);
    expect(report.needs.map((n: { path: string; required: boolean; requiredWhen?: unknown }) => [n.path, n.required, n.requiredWhen])).toEqual([
      ["databaseAccess", false, undefined],
      ["data", true, [{ "resources.databaseAccess": "absent" }]],
    ]);
    const text = runCli(["needs", "report", fixture]);
    expect(text.stdout).toMatch(/^data  DurableDirectory \(Telo\)  required when DATABASE_URL is unset$/m);
    expect(text.stdout).toMatch(/^databaseAccess  .*  optional$/m);
  });

  it("lists a library's need through every import level, keyed by its need path", () => {
    const fixture = path.join(ROOT, "tests/__fixtures__/configurations/needs/shelf-app.yaml");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.dimensions).toEqual([
      {
        key: "resources.Shelf.Notes.databaseAccess",
        values: ["present", "absent"],
        env: ["TELO_NEED_SHELF__NOTES__DATABASE_ACCESS__URL"],
      },
    ]);
    expect(report.needs.find((n: { path: string }) => n.path === "Shelf.Notes.data").requiredWhen).toEqual([
      { "resources.Shelf.Notes.databaseAccess": "absent" },
    ]);
  });

  it("reports a field sensitive when its value type declares a sensitive member, unmarked", () => {
    // The url field is a `Telo.Url`, whose password the type declares sensitive.
    const fixture = path.join(ROOT, "tests/__fixtures__/url/needs-report.yaml");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).needs[0].fields).toEqual({
      url: field("TELO_NEED_DATABASE_ACCESS__URL", "derived", true, true),
      label: field("TELO_NEED_DATABASE_ACCESS__LABEL", "derived", false, false),
    });
  });

  it("reports a kernel-declared address need under module Telo, its url not sensitive", () => {
    // A `Telo.PublicUrl`'s url forbids a password, so it holds no sensitive member.
    const fixture = path.join(ROOT, "modules/http-server/tests/__fixtures__/host-routing/serves-by-host.yaml");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    const site = JSON.parse(stdout).needs[0];
    expect(site).toMatchObject({
      path: "site",
      type: { module: "Telo", name: "PublicUrl" },
      parameters: { port: "http", primary: true },
      fields: { url: field("TELO_NEED_SITE__URL", "derived", true, false) },
    });
  });

  it("lists a need's parameters with its type's defaults filled in", () => {
    const fixture = path.join(ROOT, "cli/nodejs/tests/__fixtures__/needs-report-directory");
    const { stdout, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(0);
    expect(
      JSON.parse(stdout).needs.map((n: { path: string; type: unknown; parameters: unknown; fields: unknown }) => ({
        path: n.path,
        type: n.type,
        parameters: n.parameters,
        fields: n.fields,
      })),
    ).toEqual([
      {
        path: "uploads",
        type: { module: "Telo", name: "DurableDirectory" },
        parameters: { size: "1Gi", access: "single-writer" },
        fields: { path: field("TELO_NEED_UPLOADS__PATH", "derived", true, false) },
      },
      {
        path: "archive",
        type: { module: "Telo", name: "DurableDirectory" },
        parameters: { size: "5Gi", access: "shared" },
        fields: { path: field("TELO_NEED_ARCHIVE__PATH", "derived", true, false) },
      },
    ]);
  });

  it("gives no report for an application the kernel would refuse, naming the refusal", () => {
    // The collision is two imports deep, where only the whole-graph table sees it.
    const fixture = path.join(ROOT, "tests/__fixtures__/needs/agreement/env-collision/consumer.yaml");
    const { stdout, stderr, status } = runCli(["needs", "report", "-o", "json", fixture]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("NEED_ENV_NAME_COLLISION");
  });
});
