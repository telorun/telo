import { generatedValueRefusal, needParametersWithDefaults, readNeedTypeShape } from "@telorun/analyzer";
import { decodeSecretSeed } from "@telorun/secret-seed";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveGeneratedSecret } from "../src/generated-secrets.js";
import { environmentNeed } from "../src/controllers/module/environment-needs.js";
import { withoutHostValues } from "../src/host-values.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";
import type { UnresolvedApplicationInput } from "../src/unresolved-inputs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "..", "generated-secret-conformance", "vectors.json"), "utf8"),
) as {
  rows: Array<{ id: string; seed: string; kind: string; path: string[]; parameters: unknown; value: string }>;
  values: Array<{ id: string; kind: string; parameters: unknown; value: unknown; refusal: string | null }>;
};
const FIXTURES = path.join(HERE, "__fixtures__", "generated-secrets");

type KernelInputs = NonNullable<ConstructorParameters<typeof Kernel>[0]>["inputs"];

const SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const vector = (id: string) => VECTORS.rows.find((row) => row.id === id)!.value;

class Capture {
  readonly chunks: string[] = [];
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

/** The need type a built-in kind declares, read from its entry. */
function builtinShape(kind: string) {
  const entry = path.join(HERE, "..", "..", "..", "sdk", "builtins", `${kind.slice("Telo.".length)}.json`);
  return readNeedTypeShape(JSON.parse(fs.readFileSync(entry, "utf8")));
}

describe("the shared derivation vectors", () => {
  it("are what the derivation answers for each seed, kind, path and parameter set", () => {
    for (const row of VECTORS.rows) {
      const shape = builtinShape(row.kind);
      const seed = decodeSecretSeed(row.seed, { variable: "TELO_HOST_SECRET_SEED" });
      const parameters = needParametersWithDefaults(shape, row.parameters);
      expect(deriveGeneratedSecret(seed, row.kind, row.path, parameters), row.id).toBe(row.value);
    }
  });

  it("refuse each supplied value as the rule says, quoting no value", () => {
    for (const row of VECTORS.values) {
      expect(generatedValueRefusal(row.kind, row.parameters, row.value) ?? null, row.id).toBe(row.refusal);
    }
  });

  it("share no prefix between a longer key and a shorter one of the same need", () => {
    const short = Buffer.from(vector("key/base64url"), "base64url");
    const long = Buffer.from(vector("key/base64url-longer"), "base64url");
    expect(long.subarray(0, 4).equals(short.subarray(0, 4))).toBe(false);
  });
});

const APP = `kind: Telo.Application
metadata:
  name: Shop
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
`;

/** A document reading \`sessionKey\`, so every configuration requires it. */
const READS_KEY = `---
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

async function load(
  manifests: Record<string, string>,
  env: Record<string, string>,
  inputs?: KernelInputs,
): Promise<Kernel> {
  const memory = new MemorySource();
  for (const [name, text] of Object.entries(manifests)) memory.set(name, text);
  const kernel = new Kernel({ sources: [memory], env, stderr: new Capture().stream, ...(inputs ? { inputs } : {}) });
  await kernel.load("memory://app");
  return kernel;
}

async function failure(
  manifests: Record<string, string>,
  env: Record<string, string>,
  inputs?: KernelInputs,
) {
  try {
    const kernel = await load(manifests, env, inputs);
    await kernel.boot();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the load to fail");
}

function rootNeed(kernel: Kernel, name: string): Record<string, unknown> {
  const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
  const bound = (root as unknown as {
    resourceInstances: Map<string, { instance: { fields: Record<string, unknown> } }>;
  }).resourceInstances.get(name);
  return bound!.instance.fields;
}

describe("a generated need answered from TELO_HOST_SECRET_SEED", () => {
  it("is the derived value, the same on every load", async () => {
    const first = await load({ app: APP }, { TELO_HOST_SECRET_SEED: SEED });
    const second = await load({ app: APP }, { TELO_HOST_SECRET_SEED: SEED });
    expect(rootNeed(first, "sessionKey")).toEqual({ key: vector("key/base64url") });
    expect(rootNeed(second, "sessionKey")).toEqual(rootNeed(first, "sessionKey"));
  });

  it("writes nothing under the state directory", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "telo-generated-state-"));
    try {
      await load({ app: APP }, { TELO_HOST_SECRET_SEED: SEED, TELO_HOST_STATE_DIR: state });
      expect(fs.readdirSync(state)).toEqual([]);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it("gives a library's need nothing forwards the value of its own path", async () => {
    const library = `kind: Telo.Library
metadata:
  name: Auth
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
`;
    const app = `kind: Telo.Application\nmetadata:\n  name: Shop\nimports:\n  Auth: memory://auth\n`;
    const kernel = await load({ app, auth: library }, { TELO_HOST_SECRET_SEED: SEED });
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    expect(environmentNeed(root as never, ["Auth", "sessionKey"])).toEqual({
      key: vector("key/base64url-library-path"),
    });
  });

  it("reads the need's own env name first, and does not consult the seed then", async () => {
    const supplied = vector("key/base64url-other-need");
    const kernel = await load(
      { app: APP },
      { TELO_NEED_SESSION_KEY__KEY: supplied, TELO_HOST_SECRET_SEED: "not a seed" },
    );
    expect(rootNeed(kernel, "sessionKey")).toEqual({ key: supplied });
  });

  it("is unmet with neither set, asking for the seed alone and never a need field", async () => {
    const asked: UnresolvedApplicationInput[] = [];
    const memory = new MemorySource();
    memory.set("app", APP + READS_KEY);
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: new Capture().stream });
    const error = await kernel
      .load("memory://app", {
        inputResolver: async (unresolved) => {
          asked.push(...unresolved);
          return undefined;
        },
      })
      .catch((e: Error & { code?: string }) => e);
    expect(asked).toMatchObject([
      { id: "host TELO_HOST_SECRET_SEED", block: "host", env: "TELO_HOST_SECRET_SEED", sensitive: true, generable: true },
    ]);
    expect(error).toMatchObject({ code: "ERR_NEED_UNMET" });
    expect((error as Error).message).toContain(
      "Need 'sessionKey' (type 'Telo.GeneratedSecretKey', declared by module 'Shop') is required and " +
        "nothing supplies it. Set TELO_HOST_SECRET_SEED, or TELO_NEED_SESSION_KEY__KEY, or mark it 'optional: true'.",
    );
  });

  it("is derived from a seed the resolver answers, as if the environment held it", async () => {
    const memory = new MemorySource();
    memory.set("app", APP + READS_KEY);
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: new Capture().stream });
    await kernel.load("memory://app", {
      inputResolver: async () => new Map([["host TELO_HOST_SECRET_SEED", SEED]]),
    });
    expect(rootNeed(kernel, "sessionKey")).toEqual({ key: vector("key/base64url") });
  });

  it("refuses a seed that is not 32 bytes of unpadded base64url, never printing it", async () => {
    const error = await failure({ app: APP }, { TELO_HOST_SECRET_SEED: "shortseed" });
    expect(error.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error.message).toBe("TELO_HOST_SECRET_SEED must be 32 bytes of unpadded base64url");
  });

  it("refuses an env value its parameters reject, naming the variable and never the value", async () => {
    const thirtyOne = Buffer.alloc(31, 7).toString("base64url");
    const error = await failure({ app: APP }, { TELO_NEED_SESSION_KEY__KEY: thirtyOne });
    expect(error.code).toBe("ERR_NEED_VALUE_INVALID");
    expect(error.message).toContain(
      "Need 'sessionKey' (type 'Telo.GeneratedSecretKey', declared by module 'Shop'): " +
        "TELO_NEED_SESSION_KEY__KEY does not decode as base64url to 32 bytes.",
    );
    expect(error.message).not.toContain(thirtyOne);
  });

  it("refuses a value supplied by name that its parameters reject, naming the supplier", async () => {
    const error = await failure({ app: APP }, {}, {
      needs: { sessionKey: { key: vector("key/base64url") + "=" } },
      suppliedBy: "App.Instance/web",
    });
    expect(error.code).toBe("ERR_NEED_VALUE_INVALID");
    expect(error.message).toContain(
      "Need 'sessionKey' (type 'Telo.GeneratedSecretKey', declared by module 'Shop'): the 'key' App.Instance/web " +
        "supplied decodes as base64url to 32 bytes but is not that encoding's canonical text",
    );
  });

  it("refuses an import's computed supply that its parameters reject, when the import initializes", async () => {
    const library = `kind: Telo.Library
metadata:
  name: Auth
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
`;
    const app = `kind: Telo.Application
metadata:
  name: Shop
imports:
  Auth:
    source: memory://auth
    needs:
      sessionKey: { key: !cel "'ab' + 'c'" }
`;
    const error = await failure({ app, auth: library }, {});
    expect(JSON.stringify(error)).toContain("ERR_NEED_VALUE_INVALID");
    expect(error.message).toContain(
      "Import 'Auth': need 'sessionKey' (type 'Telo.GeneratedSecretKey'): field 'key' does not decode as base64url to 32 bytes.",
    );
  });

  it("is hidden from every controller, and stripped from a started child beside the other host values", async () => {
    const kernel = await load({ app: APP }, { TELO_HOST_SECRET_SEED: SEED, OTHER: "kept" });
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const ctx = (kernel as unknown as {
      createResourceContext(m: ModuleContext, r: unknown): { env: Record<string, string | undefined> };
    }).createResourceContext(root, { kind: "Test.Probe", metadata: { name: "probe" } });
    expect([ctx.env.TELO_HOST_SECRET_SEED, ctx.env.OTHER]).toEqual([undefined, "kept"]);
    expect(
      withoutHostValues({ TELO_HOST_SECRET_SEED: SEED, TELO_HOST_CONTAINER_ENGINE_URL: "unix:///run/engine.sock" }),
    ).toEqual({ TELO_HOST_CONTAINER_ENGINE_URL: "unix:///run/engine.sock" });
  });
});

async function run(entry: string, env: Record<string, string>) {
  const stdout = new Capture();
  const stderr = new Capture();
  const kernel = new Kernel({ sources: [new LocalFileSource()], env, stdout: stdout.stream, stderr: stderr.stream });
  await kernel.load(entry);
  await kernel.start();
  return { stdout: stdout.text, stderr: stderr.text };
}

describe("a generated need of a library or a child application", () => {
  it("reads the parent's value when the instance supplies it, as a library it is forwarded to does", async () => {
    const out = await run(path.join(FIXTURES, "parent"), { TELO_HOST_SECRET_SEED: SEED });
    expect(out.stdout).toContain("library-same=true");
    expect(out.stdout).toContain("child-same=true");
  }, 60_000);

  it("refuses at the child's start without a supply, naming the instance", async () => {
    const out = await run(path.join(FIXTURES, "unsupplied-parent"), { TELO_HOST_SECRET_SEED: SEED });
    expect(out.stderr).toContain(
      "Need 'sessionKey' (type 'Telo.GeneratedSecretKey', declared by module 'Web') is required and nothing " +
        "supplies it: App.Instance/web runs this application, and a started application is never given its " +
        "parent's TELO_HOST_SECRET_SEED. Supply it on the instance ('needs: { sessionKey: … }' on web), or " +
        "mark it 'optional: true'.",
    );
  }, 60_000);
});
