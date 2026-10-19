import { parseEnvFile } from "@telorun/analyzer";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** What a run reads from an env file. */
const readEnvValues = (text: string) =>
  Object.fromEntries(parseEnvFile(text).map((assignment) => [assignment.key, assignment.value]));

/** `telo env template`, end to end: the variables an application reads, as
 *  commented-out `.env` / `.env.local` lines. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const FIXTURES = path.join(ROOT, "cli/nodejs/tests/__fixtures__");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

function runCli(args: string[], cwd = ROOT): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args].map(quote), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.status ?? 1 };
  }
}

/** Every commented assignment set, as a developer would by uncommenting. */
const uncommented = (text: string) =>
  readEnvValues(
    text
      .split("\n")
      .filter((line) => /^# [A-Z_]+=/.test(line))
      .map((line) => line.slice(2))
      .join("\n"),
  );

/** A copy of the fixture and the need types it imports, at the same relative
 *  layout, under a directory outside any workspace or repository. */
function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-env-template-"));
  fs.cpSync(path.join(FIXTURES, "env-template"), path.join(dir, "env-template"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "needs-report/types"), path.join(dir, "needs-report/types"), { recursive: true });
  return dir;
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("telo env template", () => {
  it("splits variables and secrets between .env and .env.local, every line commented out", () => {
    const { stdout, status } = runCli(["env", "template", "-o", "json", path.join(FIXTURES, "env-template")]);
    expect(status).toBe(0);
    const files = Object.fromEntries(
      (JSON.parse(stdout).files as Array<{ name: string; text: string }>).map((f) => [f.name, f.text]),
    );

    expect(readEnvValues(files[".env"])).toEqual({});
    expect(readEnvValues(files[".env.local"])).toEqual({});
    expect(uncommented(files[".env"])).toEqual({
      GREETING: "Hello, # world",
      BUCKET: "",
      TAGS: '["a b","it\'s"]',
      PORT: "8080",
      TELO_NEED_DATABASE_ACCESS__SCHEMA: "",
    });
    // A secret's default is never written; a sensitive need field is a secret.
    expect(uncommented(files[".env.local"])).toEqual({ API_KEY: "", TELO_NEED_DATABASE_ACCESS__URL: "" });
    expect(files[".env"]).toBe(
      [
        "# Orders — written by `telo env template`. Uncomment a line to set it; a value shown is the default.",
        "",
        "# variables",
        "# GREETING='Hello, # world'  # The greeting it answers with.",
        "# BUCKET=                    # required",
        "# TAGS=`[\"a b\",\"it's\"]`",
        "",
        "# ports",
        "# PORT=8080",
        "",
        "# needs",
        "# TELO_NEED_DATABASE_ACCESS__SCHEMA=  # databaseAccess.schema",
        "",
      ].join("\n"),
    );
    expect(files[".env.local"]).toBe(
      [
        "# Orders secrets — written by `telo env template`; keep this file out of version control.",
        "",
        "# secrets",
        "# API_KEY=",
        "",
        "# needs",
        "# TELO_NEED_DATABASE_ACCESS__URL=  # required — databaseAccess.url",
        "",
      ].join("\n"),
    );
  });

  it("--write adds only the variables a file does not mention, never touching a line", () => {
    const dir = copyFixture();
    temporary.push(dir);
    const app = path.join(dir, "env-template");

    expect(runCli(["env", "template", "--write", app]).status).toBe(0);
    const env = path.join(app, ".env");
    const local = path.join(app, ".env.local");
    expect(uncommented(fs.readFileSync(local, "utf8"))).toEqual({
      API_KEY: "",
      TELO_NEED_DATABASE_ACCESS__URL: "",
    });

    const edited = fs.readFileSync(env, "utf8").replace("# BUCKET=", "BUCKET=orders");
    fs.writeFileSync(env, edited);
    const manifest = path.join(app, "telo.yaml");
    fs.writeFileSync(
      manifest,
      fs.readFileSync(manifest, "utf8").replace("secrets:", "  region:\n    type: string\n    env: REGION\nsecrets:"),
    );

    const second = runCli(["env", "template", "--write", app]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("added REGION to");
    const after = fs.readFileSync(env, "utf8");
    expect(after.startsWith(edited)).toBe(true);
    expect(after.slice(edited.length)).toBe("\n# REGION=  # required\n");
    expect(readEnvValues(after)).toEqual({ BUCKET: "orders" });
  });

  it("--write puts secrets into the last sensitive entry of env.files, the rest into the last other one", () => {
    const dir = copyFixture();
    temporary.push(dir);
    fs.writeFileSync(
      path.join(dir, "telo-workspace.yaml"),
      "env:\n  files: [.env, { name: .secrets, sensitive: true }, .env.shared]\n",
    );
    const app = path.join(dir, "env-template");

    expect(runCli(["env", "template", "--write", app]).status).toBe(0);
    expect(uncommented(fs.readFileSync(path.join(app, ".secrets"), "utf8"))).toEqual({
      API_KEY: "",
      TELO_NEED_DATABASE_ACCESS__URL: "",
    });
    expect(Object.keys(uncommented(fs.readFileSync(path.join(app, ".env.shared"), "utf8")))).toContain("BUCKET");
    expect(fs.existsSync(path.join(app, ".env"))).toBe(false);
  });

  it("--write refuses when env.files marks no file sensitive, writing nothing", () => {
    const dir = copyFixture();
    temporary.push(dir);
    fs.writeFileSync(path.join(dir, "telo-workspace.yaml"), "env:\n  files:\n    - .env\n");
    const app = path.join(dir, "env-template");

    const { stderr, status } = runCli(["env", "template", "--write", app]);
    expect(status).toBe(1);
    expect(stderr).toContain("env.files in telo-workspace.yaml marks no file sensitive");
    expect(fs.existsSync(path.join(app, ".env"))).toBe(false);
  });
});
