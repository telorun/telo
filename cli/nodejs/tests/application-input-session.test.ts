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
import { ApplicationInputSession, offerToSaveAnswers, unresolvedInputsHint } from "../src/application-input-session.js";
import { resolveEnvFiles } from "../src/env-files.js";
import { createLogger } from "../src/logger.js";

const silent = { write: () => true } as unknown as NodeJS.WritableStream;

/** An input is asked for only where a manifest reads it: this reads them all. */
const reader = (read: string) => `---
kind: Telo.NeedType
metadata: { name: Probe }
fields:
  all: { type: object }
---
kind: Self.Probe
metadata: { name: reader }
fields:
  all: !cel "${read}"
`;
const READS_VARIABLES = reader("variables");

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
${variables}${READS_VARIABLES}`;

async function load(manifest: string, session: ApplicationInputSession, env: Record<string, string> = {}) {
  const memory = new MemorySource();
  memory.set("app", manifest);
  const kernel = new Kernel({ sources: [memory], env, stderr: silent });
  await kernel.load("memory://app", { inputResolver: session.resolve });
  return kernel;
}

describe("a prompter that asks every input at once", () => {
  const entry = (name: string, extra: object = {}) =>
    ({ id: `variables.${name}`, block: "variables", name, sensitive: false, type: "string", schema: {}, ...extra }) as never;

  it("is asked once for the entries not answered yet, and a refused entry again", async () => {
    const calls: string[][] = [];
    const session = new ApplicationInputSession({
      ask: async () => null,
      askAll: async (inputs) => {
        calls.push(inputs.map((input) => input.id));
        return new Map(inputs.map((input) => [input.id, `${input.id}!`]));
      },
      confirm: async () => false,
      say: () => undefined,
    });
    const first = await session.resolve([entry("a"), entry("b")]);
    expect([...first!]).toEqual([["variables.a", "variables.a!"], ["variables.b", "variables.b!"]]);
    await session.resolve([entry("a"), entry("b", { refusal: "bad" })]);
    expect(calls).toEqual([["variables.a", "variables.b"], ["variables.b"]]);
    expect(session.takeFresh().map((answer) => answer.input.id)).toEqual(["variables.a", "variables.b"]);
  });

  it("declines when the prompter ends the input", async () => {
    const session = new ApplicationInputSession({ ask: async () => null, askAll: async () => undefined, confirm: async () => false, say: () => undefined });
    expect(await session.resolve([entry("a")])).toBeUndefined();
  });
});

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
${reader("{'variables': variables, 'secrets': secrets}")}`;
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
    await load(`kind: Telo.Application\nmetadata:\n  name: NoSensitive\nsecrets:\n  token: { env: SAVED_TOKEN, type: string }\n${reader("secrets")}`, session);
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

describe("the host's secret seed", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-seed-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SENSITIVE_FILE = [".env", "local"].join(".");
  const SEEDED = `kind: Telo.Application
metadata: { name: Seeded }
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
---
kind: Telo.NeedType
metadata: { name: Probe }
fields:
  value: { type: integer }
---
kind: Self.Probe
metadata: { name: reader }
fields:
  value: !cel "size(resources.sessionKey.key)"
`;

  function session(confirms: boolean[], remote = false) {
    const seen: Array<{ question: string; defaultYes?: boolean }> = [];
    const asked: string[] = [];
    const prompter: InputPrompter = {
      async ask(input) {
        asked.push(input.id);
        return null;
      },
      async confirm(question, options) {
        seen.push({ question, ...options });
        return confirms.shift() ?? false;
      },
      say: () => undefined,
    };
    const result = new ApplicationInputSession(prompter);
    result.seedOffer = { directory: remote ? undefined : dir, envFiles: DEFAULT_ENV_FILES, log: createLogger(false) };
    return { result, seen, asked };
  }

  it("is offered once, written to the sensitive env file on yes, and the values follow from it", async () => {
    const { result, seen, asked } = session([true]);
    await load(SEEDED, result);
    expect(seen).toEqual([
      { question: `TELO_HOST_SECRET_SEED is not set — generate one and save it to ${SENSITIVE_FILE}?`, defaultYes: true },
    ]);
    expect(asked).toEqual([]);
    const written = fs.readFileSync(path.join(dir, SENSITIVE_FILE), "utf8");
    const lines = written.split("\n").filter((line) => line.startsWith("TELO_HOST_SECRET_SEED="));
    expect(lines).toHaveLength(1);
    const seed = lines[0]!.slice("TELO_HOST_SECRET_SEED=".length);
    expect(seed).toHaveLength(43);

    // The next run reads the seed from the file and asks nothing; a reload of this one asks nothing either.
    const again = session([]);
    await load(SEEDED, again.result, { TELO_HOST_SECRET_SEED: seed });
    expect(again.seen).toEqual([]);
    await load(SEEDED, result);
    expect(seen).toHaveLength(1);
  });

  it("writes nothing and refuses with ERR_NEED_UNMET on no", async () => {
    const { result } = session([false]);
    await expect(load(SEEDED, result)).rejects.toMatchObject({ code: "ERR_NEED_UNMET" });
    expect(fs.existsSync(path.join(dir, SENSITIVE_FILE))).toBe(false);
  });

  it("refuses the run naming the file when it cannot be written", async () => {
    fs.mkdirSync(path.join(dir, SENSITIVE_FILE));
    const { result } = session([true]);
    const error = await load(SEEDED, result).catch((e: Error) => e);
    expect((error as Error).message).toContain(`cannot save TELO_HOST_SECRET_SEED to ${path.join(dir, SENSITIVE_FILE)}`);
  });

  it("offers nothing for a manifest that is a URL", async () => {
    const { result, seen } = session([true], true);
    await expect(load(SEEDED, result)).rejects.toMatchObject({ code: "ERR_NEED_UNMET" });
    expect(seen).toEqual([]);
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
        `kind: Telo.Application\nmetadata:\n  name: NoTerminal\nsecrets:\n  token:\n    env: TELO_TEST_NO_INPUT_TOKEN\n    type: string\n${reader("secrets")}`,
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

describe("the hint a refusal ends with when nothing could ask", () => {
  it("offers generation for the seed and the template for the rest", () => {
    const hint = unresolvedInputsHint(
      [
        { id: "secrets TOKEN", env: "TOKEN" },
        { id: "host TELO_HOST_SECRET_SEED", env: "TELO_HOST_SECRET_SEED", generable: true },
      ] as never,
      true,
    );
    expect(hint).toBe(
      "TOKEN has no value: run without `--no-input` to be asked, or write them with `telo env template --write`. " +
        "TELO_HOST_SECRET_SEED has no value: run in a terminal without `--no-input` to have one generated and saved, " +
        "or set it to 32 random bytes as unpadded base64url.",
    );
  });
});
