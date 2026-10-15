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
      needs: [
        {
          path: "sessionKey",
          declaredBy: "./",
          type: { module: "./types", name: "SigningKey" },
          version: null,
          features: [],
          parameters: {},
          optional: false,
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
        fields: { url: field("CONSUME_DATABASE_URL", "bound", true, true) },
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
