import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/configurations",
);

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-demand-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function kernelFor(env: Record<string, string>, argv: string[] = []): Kernel {
  return new Kernel({ sources: [new LocalFileSource()], env, argv });
}

/** Load and boot `fixture`, returning the configuration it started in. */
async function boot(fixture: string, env: Record<string, string>): Promise<unknown> {
  const kernel = kernelFor(env);
  let configuration: unknown;
  kernel.on("Kernel.Starting", (event) => {
    configuration = (event.payload as { configuration: unknown }).configuration;
  });
  await kernel.load(path.join(FIXTURES, fixture), { cacheDir: null });
  try {
    await kernel.boot();
    await kernel.runTargets();
  } finally {
    await kernel.teardown();
  }
  return configuration;
}

/** The refusal loading `fixture` under `env` raises. */
async function refusal(fixture: string, env: Record<string, string>): Promise<{ code?: string; message: string }> {
  try {
    await kernelFor(env).load(path.join(FIXTURES, fixture), { cacheDir: null });
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected the load to be refused");
}

describe("the inputs a configuration demands", () => {
  it("demands a secret only where the branch reading it is chosen", async () => {
    await boot("requirements/provider.yaml", { OPENAI_API_KEY: "sk-o" });
    await boot("requirements/provider.yaml", { ANTHROPIC_API_KEY: "sk-a" });
    const refused = await refusal("requirements/provider.yaml", {});
    expect(refused.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(refused.message).toContain("anthropicApiKey");
    expect(refused.message).not.toContain("openaiApiKey");
  });

  it("demands a required need only where its consumer is chosen, refusing an unmet one before anything exists", async () => {
    // Loaded only: its targets run the standard library (`tests/configurations.yaml` boots it).
    await kernelFor({ NEED_A_URL: "mem://a" }).load(path.join(FIXTURES, "needs/presence.yaml"), { cacheDir: null });
    const refused = await refusal("needs/presence.yaml", {});
    expect(refused.code).toBe("ERR_NEED_UNMET");
    expect(refused.message).toContain("NEED_B_URL");
    expect(refused.message).not.toContain("NEED_A_URL");
  });

  it("starts the database example on the state directory alone, and names only its path when nothing is set", async () => {
    expect(await boot("needs/database.yaml", { TELO_HOST_STATE_DIR: scratch })).toEqual({
      "resources.databaseAccess": "absent",
    });
    expect(fs.statSync(path.join(scratch, "needs", "data")).isDirectory()).toBe(true);
    expect(await boot("needs/database.yaml", { DATABASE_URL: "mem://db" })).toEqual({
      "resources.databaseAccess": "present",
    });
    const refused = await refusal("needs/database.yaml", {});
    expect(refused.code).toBe("ERR_NEED_UNMET");
    expect(refused.message).toContain("TELO_NEED_DATA__PATH");
    expect(refused.message).not.toContain("DATABASE_URL");
  });

  it("binds a library's need its configuration does not require to nothing, through the import", async () => {
    expect(
      await boot("needs/notes-app.yaml", { TELO_NEED_NOTES__DATABASE_ACCESS__URL: "mem://notes" }),
    ).toEqual({ "resources.Notes.databaseAccess": "present" });
    const refused = await refusal("needs/notes-app.yaml", {});
    expect(refused.code).toBe("ERR_NEED_UNMET");
    expect(refused.message).toContain("TELO_NEED_NOTES__DATA__PATH");
    expect(refused.message).not.toContain("TELO_NEED_NOTES__DATABASE_ACCESS__URL");
  });

  it("translates a library's requirement through every import level", async () => {
    expect(
      await boot("needs/shelf-app.yaml", { TELO_NEED_SHELF__NOTES__DATABASE_ACCESS__URL: "mem://notes" }),
    ).toEqual({ "resources.Shelf.Notes.databaseAccess": "present" });
    const refused = await refusal("needs/shelf-app.yaml", {});
    expect(refused.code).toBe("ERR_NEED_UNMET");
    expect(refused.message).toContain("TELO_NEED_SHELF__NOTES__DATA__PATH");
    expect(refused.message).not.toContain("DATABASE_ACCESS");
  });

  it("answers --help with each input's requirement in the environment's names", async () => {
    const provider = kernelFor({}, ["--help"]);
    await provider.load(path.join(FIXTURES, "requirements/provider.yaml"), { cacheDir: null });
    expect(provider.applicationHelp).toContain(
      "ANTHROPIC_API_KEY  [string; secret; required when OPENAI_API_KEY is unset; secrets.anthropicApiKey]",
    );
    expect(provider.applicationHelp).toContain("OPENAI_API_KEY     [string; secret; secrets.openaiApiKey]");

    const database = kernelFor({}, ["--help"]);
    await database.load(path.join(FIXTURES, "needs/database.yaml"), { cacheDir: null });
    expect(database.applicationHelp).toContain(
      "data            TELO_NEED_DATA__PATH, TELO_HOST_STATE_DIR [Telo.DurableDirectory; required when DATABASE_URL is unset]",
    );
  });
});
