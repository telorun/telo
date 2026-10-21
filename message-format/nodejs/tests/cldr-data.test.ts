import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generator = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "generate-cldr-data.mjs");

describe("message-format/cldr/", () => {
  it("is what the pinned CLDR packages generate", () => {
    expect(execFileSync(process.execPath, [generator, "--check"], { encoding: "utf8" })).toContain(
      "message-format/cldr/ is CLDR 48.2.0.",
    );
  });
});
