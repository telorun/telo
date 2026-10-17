import { BUILTIN_VOCABULARY_ARCHIVE, readBuiltinVocabulary } from "@telorun/analyzer";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/telo.ts");
// On Windows `bun` is a `.cmd` shim, spawned through cmd.exe, which quotes nothing.
const VIA_CMD = process.platform === "win32";

describe("telo --version", () => {
  it("prints the telo identity the built-in vocabulary carries, not the package number", () => {
    const stdout = execFileSync("bun", [VIA_CMD ? `"${CLI}"` : CLI, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
    });
    expect(stdout).toBe(`${readBuiltinVocabulary(BUILTIN_VOCABULARY_ARCHIVE).vocabulary?.version}\n`);
  });
});
