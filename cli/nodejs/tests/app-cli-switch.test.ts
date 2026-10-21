import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { takeAppCliSwitch } from "../src/app-cli-switch.js";
import { encodeTrailer } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NPM_ENTRY = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const STANDALONE_ENTRY = path.join(ROOT, "cli/nodejs/src/standalone/entry.ts");
const FIXTURES = path.join(ROOT, "cli/nodejs/tests/__fixtures__");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);
const execFileAsync = promisify(execFile);

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `program` with `args` and `env` laid over this process's environment. */
async function start(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shell = false,
): Promise<{ stdout: string; stderr: string; status: number }> {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  try {
    const { stdout, stderr } = await execFileAsync(program, shell ? args.map(quote) : args, {
      cwd: ROOT,
      encoding: "utf8",
      shell,
      env: childEnv,
    });
    return { stdout, stderr, status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.code ?? 1 };
  }
}

const bun = (args: string[], env: NodeJS.ProcessEnv) => start("bun", args, env, VIA_CMD);

/**
 * A carrier is an executable with a payload after its own bytes; the bun
 * running this suite, copied with `fixture` packaged and appended, is one whose
 * start reaches the standalone entry's dispatch. An unsigned Mach-O with bytes
 * appended does not launch, so the tests using it run where the trailer
 * placement applies.
 */
async function packagedCarrier(fixture: string, name: string): Promise<{ dir: string; carrier: string }> {
  // The real path: an executable reports its own path in long form, and a
  // Windows temp directory may be given in 8.3 form.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `telo-${name}-`));
  scratch.push(dir);
  const { stdout: bunPath } = await bun(["-e", "process.stdout.write(process.execPath)"], {});
  const { payload } = await buildAppPayload({
    manifestPath: path.join(FIXTURES, fixture),
    platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
    report: () => {},
  });
  const carrier = path.join(dir, VIA_CMD ? `${name}.exe` : name);
  fs.writeFileSync(carrier, Buffer.concat([fs.readFileSync(bunPath), payload, encodeTrailer(payload)]));
  fs.chmodSync(carrier, 0o755);
  return { dir, carrier };
}

const carrierSupported = process.platform !== "darwin";

/** `TELO_APP_CLI`: read once, removed from the environment whatever it holds,
 *  and anything but `1`, empty or unset refused naming the variable. */
describe("TELO_APP_CLI", () => {
  it("reads 1 as the CLI, unset or empty as the application, and removes it either way", () => {
    for (const [value, kind] of [
      ["1", "cli"],
      ["", "application"],
      [undefined, "application"],
    ] as const) {
      const env: NodeJS.ProcessEnv = { TELO_APP_CLI: value, HOME: "/home/someone" };
      expect(takeAppCliSwitch(env)).toEqual({ kind });
      expect(env).toEqual({ HOME: "/home/someone" });
    }
  });

  it("refuses any other value, naming the variable and the value it takes", () => {
    const env: NodeJS.ProcessEnv = { TELO_APP_CLI: "yes" };
    const verdict = takeAppCliSwitch(env);
    expect(verdict.kind).toBe("refused");
    expect(verdict.kind === "refused" && verdict.message).toMatch(/^TELO_APP_CLI is set to 'yes'.*TELO_APP_CLI=1/);
    expect("TELO_APP_CLI" in env).toBe(false);
  });

  it("refuses the start at both entry points with exit status 2 and nothing on stdout", async () => {
    for (const entry of [NPM_ENTRY, STANDALONE_ENTRY]) {
      const refused = await bun([entry, "--version"], { TELO_APP_CLI: "yes" });
      expect(refused.status, entry).toBe(2);
      expect(refused.stdout, entry).toBe("");
      expect(refused.stderr, entry).toMatch(/^TELO_APP_CLI is set to 'yes'/);
    }
  }, 30_000);

  it("is gone before the kernel starts: a controller and a process it starts see it unset", async () => {
    const run = await bun([NPM_ENTRY, "run", path.join(FIXTURES, "app-cli-env")], { TELO_APP_CLI: "1" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("controller=unset child=unset");
  }, 30_000);
});

describe("TELO_APP_INFO", () => {
  it.skipIf(!carrierSupported)(
    "refuses a packaged start while it is set, with exit status 2, naming the command that prints the index",
    async () => {
      const { dir, carrier } = await packagedCarrier("packaged-source", "announcer");

      const refused = await start(carrier, [STANDALONE_ENTRY], {
        TELO_APP_INFO: "1",
        TELO_APP_CLI: undefined,
        TELO_APP_DIR: path.join(dir, "apps-root"),
      });
      expect(refused.status, refused.stderr).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(`TELO_APP_CLI=1 ${carrier} package inspect ${carrier}`);
      expect(fs.existsSync(path.join(dir, "apps-root"))).toBe(false);
    },
    60_000,
  );
});

describe("a packaged executable", () => {
  it.skipIf(!carrierSupported)(
    "runs `./greeter <args>` exactly as `TELO_APP_CLI=1 ./greeter run ./greeter <args>`: one unpack directory, the same output and exit",
    async () => {
      const { dir, carrier } = await packagedCarrier("packaged-dispatch", "greeter");
      const appDir = path.join(dir, "apps-root");

      const started = await start(carrier, [STANDALONE_ENTRY, "--greeting", "hi"], {
        TELO_APP_CLI: undefined,
        TELO_APP_DIR: appDir,
      });
      const unpacked = fs.readdirSync(path.join(appDir, "apps"));
      expect(unpacked).toHaveLength(1);
      const ran = await start(carrier, [STANDALONE_ENTRY, "run", carrier, "--greeting", "hi"], {
        TELO_APP_CLI: "1",
        TELO_APP_DIR: appDir,
      });

      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toMatch(/^hi from /);
      expect(started.stdout).toContain(path.join(appDir, "apps", unpacked[0]!));
      expect(ran).toEqual(started);
      // A run reclaims the app's other digests, so a second directory would
      // have replaced the first.
      expect(fs.readdirSync(path.join(appDir, "apps"))).toEqual(unpacked);
    },
    90_000,
  );

  it.skipIf(!carrierSupported)(
    "is a runner under TELO_APP_CLI=1, and a session it starts runs",
    async () => {
      const { dir, carrier } = await packagedCarrier("packaged-dispatch", "greeter");
      const runner = spawn(
        carrier,
        [STANDALONE_ENTRY, "-o", "json", "runner", "--port", "0", "--state-dir", path.join(dir, "state")],
        {
          cwd: ROOT,
          env: { ...process.env, TELO_APP_CLI: "1", TELO_APP_DIR: path.join(dir, "apps-root") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      runner.stderr.on("data", (chunk) => (stderr += String(chunk)));
      try {
        const url = await new Promise<string>((resolve, reject) => {
          // Under `-o json` stdout carries the address document and nothing else.
          let stdout = "";
          runner.stdout.on("data", (chunk) => {
            stdout += String(chunk);
            const url = /"url":\s*"([^"]+)"/.exec(stdout)?.[1];
            if (url) resolve(url);
          });
          runner.on("exit", (code) => reject(new Error(`the runner exited (${code}) before listening: ${stderr}`)));
        });

        const created = await fetch(`${url}/v1/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bundle: {
              entryRelativePath: "telo.yaml",
              files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\nmetadata: { name: Empty }\n" }],
            },
            env: {},
          }),
        });
        expect(created.status, await created.clone().text()).toBe(201);
        const { sessionId } = (await created.json()) as { sessionId: string };

        let status: { kind: string; code?: number; message?: string } = { kind: "starting" };
        for (let i = 0; i < 600 && (status.kind === "starting" || status.kind === "running"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = ((await (await fetch(`${url}/v1/sessions/${sessionId}`)).json()) as { status: typeof status })
            .status;
        }
        // A run session IS its run: the telo it started ran the manifest and
        // exited cleanly.
        expect(status, stderr).toEqual({ kind: "exited", code: 0 });
      } finally {
        // Waited for, so the directory it runs from is no longer in use when the
        // suite removes it — Windows refuses to delete a running executable.
        if (runner.exitCode === null && runner.signalCode === null) {
          const exited = new Promise((resolve) => runner.once("exit", resolve));
          runner.kill("SIGTERM");
          await exited;
        }
      }
    },
    90_000,
  );
});
