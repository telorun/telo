import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSecretSeed,
  deriveChildSeed,
  encodeSecretSeed,
  generateSecretSeed,
  readOrCreateSecretSeedFile,
  SecretSeedError,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(new URL("../conformance/secret-seed.json", import.meta.url), "utf8"),
);
const source = { variable: "TELO_HOST_SECRET_SEED" };

describe("conformance vectors", () => {
  for (const row of vectors.decode) {
    it(`decode: ${row.name}`, () => {
      if (row.refused) {
        const call = () => decodeSecretSeed(row.text, source);
        expect(call).toThrow(SecretSeedError);
        expect(call).toThrow(vectors.refusals.variable);
        if (row.text) expect(call).not.toThrow(row.text);
        return;
      }
      const bytes = decodeSecretSeed(row.text, source);
      expect(Buffer.from(bytes).toString("hex")).toBe(row.bytesHex);
      expect(encodeSecretSeed(bytes)).toBe(row.text);
    });
  }

  for (const row of vectors.derive) {
    it(`derive: ${JSON.stringify(row.label)}`, () => {
      const child = deriveChildSeed(decodeSecretSeed(row.seed, source), row.label);
      expect(encodeSecretSeed(child)).toBe(row.child);
    });
  }

  it("refuses a file naming its path", () => {
    expect(() => decodeSecretSeed("x", { file: "/a/secret-seed" })).toThrow(
      vectors.refusals.file.replace("<path>", "/a/secret-seed"),
    );
  });
});

describe("generation", () => {
  it("generates a 32-byte seed that survives encode and decode", () => {
    const seed = generateSecretSeed();
    expect(decodeSecretSeed(encodeSecretSeed(seed), source)).toEqual(seed);
  });
});

describe("secret-seed file", () => {
  const directory = () => mkdtempSync(join(tmpdir(), "secret-seed-"));

  it("creates a private file once and reads it from then on", () => {
    const path = join(directory(), "nested", "secret-seed");
    const first = readOrCreateSecretSeedFile(path);
    expect(readFileSync(path, "utf8")).toBe(`${encodeSecretSeed(first)}\n`);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readOrCreateSecretSeedFile(path)).toEqual(first);
  });

  it("reads a file without the trailing newline", () => {
    const path = join(directory(), "secret-seed");
    const seed = generateSecretSeed();
    writeFileSync(path, encodeSecretSeed(seed));
    expect(readOrCreateSecretSeedFile(path)).toEqual(seed);
  });

  it("refuses a malformed file naming it and leaves it untouched", () => {
    const path = join(directory(), "secret-seed");
    writeFileSync(path, "truncated\n");
    expect(() => readOrCreateSecretSeedFile(path)).toThrow(
      `${path} does not hold 32 bytes of unpadded base64url`,
    );
    expect(readFileSync(path, "utf8")).toBe("truncated\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads an existing file in a directory it cannot write, leaving nothing beside it",
    () => {
      const dir = directory();
      const path = join(dir, "secret-seed");
      const seed = generateSecretSeed();
      writeFileSync(path, `${encodeSecretSeed(seed)}\n`);
      chmodSync(dir, 0o500);
      try {
        expect(readOrCreateSecretSeedFile(path)).toEqual(seed);
        expect(readdirSync(dir)).toEqual(["secret-seed"]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});
