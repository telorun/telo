import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";

// The same cases `kernel/rust/src/bundle/files_integrity.rs` runs: a layer
// whose integrity the two kernels compute differently verifies on one of them
// only.
const { filesIntegrity } = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../analyzer/artifact-axes/layer-index-vectors.json",
    ),
    "utf-8",
  ),
) as {
  filesIntegrity: Array<{
    name: string;
    files: Array<{ name: string; content?: string; executable?: boolean; link?: string }>;
    integrity: string;
  }>;
};

describe("shared files-integrity vectors", () => {
  it("computes each layer's integrity", async () => {
    for (const v of filesIntegrity) {
      const files: PayloadFile[] = v.files.map((f) =>
        f.link !== undefined
          ? { name: f.name, link: f.link }
          : { name: f.name, content: Buffer.from(f.content ?? ""), executable: f.executable },
      );
      expect(await computeFilesIntegrity(files), v.name).toBe(v.integrity);
    }
  });
});
