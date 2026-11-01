import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { format } from "../src/commands/format.js";
import { Output, installOutput } from "../src/output.js";

const UNFORMATTED = "kind: Telo.Library\nmetadata:\n  name: D\ne:\n  - a\n  - b\n";
const FORMATTED = "kind: Telo.Library\nmetadata: { name: D }\ne: [a, b]\n";

let dir: string;
let cwd: string;

beforeEach(async () => {
  cwd = process.cwd();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-format-"));
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  process.exitCode = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

async function run(argv: { paths?: string[]; check?: boolean }): Promise<string> {
  const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
  const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
  const restore = installOutput(new Output({ format: "text", stdout, stderr, env: {} }));
  try {
    await format(argv);
  } finally {
    restore();
  }
  return stdout.text + stderr.text;
}

describe("telo format", () => {
  it("rewrites in place, skipping fixtures and non-manifests in a search", async () => {
    await fs.mkdir("__fixtures__");
    await fs.writeFile("telo.yaml", UNFORMATTED);
    await fs.writeFile("__fixtures__/f.yaml", UNFORMATTED);
    await fs.writeFile("k8s.yaml", "apiVersion: v1\nkind: Deployment\n");
    await run({});
    expect(await fs.readFile("telo.yaml", "utf-8")).toBe(FORMATTED);
    expect(await fs.readFile("__fixtures__/f.yaml", "utf-8")).toBe(UNFORMATTED);
    expect(process.exitCode).toBeUndefined();
  });

  it("--check writes nothing and exits 1", async () => {
    await fs.writeFile("telo.yaml", UNFORMATTED);
    await run({ check: true });
    expect(await fs.readFile("telo.yaml", "utf-8")).toBe(UNFORMATTED);
    expect(process.exitCode).toBe(1);
  });

  it("formats a named fixture and refuses a named non-manifest", async () => {
    await fs.mkdir("__fixtures__");
    await fs.writeFile("__fixtures__/f.yaml", UNFORMATTED);
    await fs.writeFile("k8s.yaml", "apiVersion: v1\nkind: Deployment\n");
    await run({ paths: ["__fixtures__/f.yaml"] });
    expect(await fs.readFile("__fixtures__/f.yaml", "utf-8")).toBe(FORMATTED);
    const output = await run({ paths: ["k8s.yaml"] });
    expect(output).toContain("not a Telo manifest");
    expect(process.exitCode).toBe(2);
  });

  it("reports a broken file with its line, exits 2 and still formats its neighbours", async () => {
    await fs.writeFile("broken.yaml", "kind: A.B\nl: [a\n");
    await fs.writeFile("telo.yaml", UNFORMATTED);
    const output = await run({});
    expect(output).toMatch(/broken\.yaml:\d+:\d+/);
    expect(await fs.readFile("telo.yaml", "utf-8")).toBe(FORMATTED);
    expect(process.exitCode).toBe(2);
  });
});
