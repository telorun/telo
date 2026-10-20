import { DEFAULT_ENV_FILES } from "@telorun/analyzer";
import { Kernel } from "@telorun/kernel";
import { MemorySource } from "@telorun/kernel/memory-source";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InputPrompter } from "../src/application-input-prompt.js";
import { ApplicationInputSession, offerToSaveAnswers } from "../src/application-input-session.js";
import { resolveEnvFiles } from "../src/env-files.js";
import { createLogger } from "../src/logger.js";

const silent = { write: () => true } as unknown as NodeJS.WritableStream;

/** A person who answers from `answers` (each id's queue in turn, then the end
 *  of input) and says yes or no to each confirmation in order. */
function person(answers: Record<string, string[]>, confirms: boolean[] = []) {
  const asked: string[] = [];
  const said: string[] = [];
  const prompter: InputPrompter = {
    async ask(input) {
      asked.push(input.id);
      return answers[input.id]?.shift() ?? null;
    },
    async confirm() {
      return confirms.shift() ?? false;
    },
    say(line) {
      said.push(line);
    },
  };
  return { prompter, asked, said };
}

const app = (variables: string) => `kind: Telo.Application
metadata:
  name: Watched
variables:
${variables}`;

async function load(manifest: string, session: ApplicationInputSession, env: Record<string, string> = {}) {
  const memory = new MemorySource();
  memory.set("app", manifest);
  const kernel = new Kernel({ sources: [memory], env, stderr: silent });
  await kernel.load("memory://app", { inputResolver: session.resolve });
  return kernel;
}

describe("a run's answers", () => {
  it("are kept across reloads: a reload asks only for a new entry, or one it refuses", async () => {
    const { prompter, asked } = person({ "variables.region": ["eu", "7"], "variables.zone": ["a"] });
    const session = new ApplicationInputSession(prompter);
    await load(app("  region: { env: REGION, type: string }\n"), session);
    await load(app("  region: { env: REGION, type: string }\n  zone: { env: ZONE, type: string }\n"), session);
    expect(asked).toEqual(["variables.region", "variables.zone"]);

    // The kept "eu" is no integer: the reload refuses it and asks again.
    await load(app("  region: { env: REGION, type: integer }\n  zone: { env: ZONE, type: string }\n"), session);
    expect(asked).toEqual(["variables.region", "variables.zone", "variables.region"]);
  });
});

describe("saving answers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-asked-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifest = `kind: Telo.Application
metadata:
  name: Saved
variables:
  host: { env: SAVED_HOST, type: string }
  quote: { env: SAVED_QUOTE, type: string }
secrets:
  token: { env: SAVED_TOKEN, type: string }
`;
  const answers = () => ({
    "variables.host": ["db.local"],
    "variables.quote": [`it's "all" \`three\``],
    "secrets.token": ["s3cr3t"],
  });

  async function answered(confirm: boolean) {
    const { prompter, said } = person(answers(), [confirm]);
    const session = new ApplicationInputSession(prompter);
    await load(manifest, session);
    await offerToSaveAnswers(session.takeFresh(), {
      directory: dir,
      envFiles: DEFAULT_ENV_FILES,
      prompter,
      log: createLogger(false),
    });
    return said;
  }

  it("writes nothing when declined", async () => {
    await answered(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("puts a secret only in the sensitive file, names a value it cannot spell, and the next run asks only for that one", async () => {
    const said = await answered(true);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("SAVED_HOST=db.local\n");
    expect(said).toContain(
      "SAVED_QUOTE is not saved: the value of SAVED_QUOTE cannot be written to an env file: it holds all three quote characters, so no quoting reads it back literally",
    );

    const resolution = await resolveEnvFiles(dir);
    expect(resolution.values).toEqual({ SAVED_HOST: "db.local", SAVED_TOKEN: "s3cr3t" });
    expect(path.basename(resolution.sources.SAVED_TOKEN!)).toBe(".env.local");

    const next = person({ "variables.quote": ["q"] });
    await load(manifest, new ApplicationInputSession(next.prompter), { ...resolution.values });
    expect(next.asked).toEqual(["variables.quote"]);
  });

  it("saves no secret when no file is marked sensitive, and says so", async () => {
    const { prompter, said } = person({ "secrets.token": ["s3cr3t"] }, [true]);
    const session = new ApplicationInputSession(prompter);
    await load(`kind: Telo.Application\nmetadata:\n  name: NoSensitive\nsecrets:\n  token: { env: SAVED_TOKEN, type: string }\n`, session);
    await offerToSaveAnswers(session.takeFresh(), {
      directory: dir,
      envFiles: [{ name: ".env", sensitive: false }],
      prompter,
      log: createLogger(false),
    });
    expect(said.join("\n")).toContain("marks no file sensitive");
    expect(said.join("\n")).toContain("Not saving SAVED_TOKEN.");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("telo run with no terminal", () => {
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/telo.ts");
  const VIA_CMD = process.platform === "win32";
  const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

  it("never asks: it refuses as before and names the two ways to supply the values", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-noinput-")));
    try {
      fs.mkdirSync(path.join(dir, "app"));
      const manifest = path.join(dir, "app", "telo.yaml");
      fs.writeFileSync(
        manifest,
        "kind: Telo.Application\nmetadata:\n  name: NoTerminal\nsecrets:\n  token:\n    env: TELO_TEST_NO_INPUT_TOKEN\n    type: string\n",
      );
      const result = spawnSync("bun", [CLI, "run", manifest].map(quote), {
        cwd: dir,
        encoding: "utf8",
        shell: VIA_CMD,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("environment variable TELO_TEST_NO_INPUT_TOKEN is not set (no default)");
      expect(result.stderr).toContain(
        "TELO_TEST_NO_INPUT_TOKEN has no value: run in a terminal to be asked, or write them with `telo env template --write`.",
      );
      expect(result.stderr).not.toContain("enter it below");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
