import { readOwnerManifest } from "@telorun/kernel";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinVocabularyPayload } from "../src/bundle/builtin-vocabulary-payload.js";

const ARCHIVE = `kind: Telo.Builtins
metadata:
  name: Telo
  version: 0.119.0
  license: MIT
$defs:
  LogLevel:
    type: string
---
kind: Telo.Abstract
metadata:
  name: Service
capability: Telo.Service
declarable: true
`;

const dirs: string[] = [];
function archiveDir(text: string, license = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-builtins-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "builtins.yaml"), text);
  if (license) fs.writeFileSync(path.join(dir, "LICENSE"), "MIT License\n");
  return path.join(dir, "builtins.yaml");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("builtinVocabularyPayload", () => {
  it("publishes the archive's bytes with the layers: index appended to its first document", async () => {
    const payload = await builtinVocabularyPayload(archiveDir(ARCHIVE), "oci://ghcr.io/example/telo");

    const [root, rest] = ARCHIVE.split(/(?<=\n)(?=---\n)/);
    expect(payload.manifest.startsWith(root!)).toBe(true);
    expect(payload.manifest.endsWith(rest!)).toBe(true);
    const block = payload.manifest.slice(root!.length, payload.manifest.length - rest!.length);
    expect(block).toMatch(/^layers:\n {2}- role: "common"\n {4}blob: "sha256:[0-9a-f]{64}"\n {4}integrity: "sha256-[A-Za-z0-9_-]{43}"\n$/);
    expect(readOwnerManifest(payload.manifest)).toMatchObject({
      name: "Telo",
      version: "0.119.0",
      license: "MIT",
      layers: [{ role: "common" }],
    });
    expect(payload.layers.map((layer) => layer.files.map((file) => file.name))).toEqual([["LICENSE"]]);
  });

  it.each([
    ["an archive the reader refuses", archiveDir.bind(null, ARCHIVE.replace("  license: MIT\n", "")), "does not declare `metadata.license: MIT`"],
    ["an unreleased archive", archiveDir.bind(null, ARCHIVE.replace("0.119.0", "0.119.0+unreleased")), "a build of an unreleased tree"],
    ["an archive with no LICENSE beside it", archiveDir.bind(null, ARCHIVE, false), "has no LICENSE beside it"],
  ])("refuses %s as manifest_invalid", async (_case, write, message) => {
    await expect(builtinVocabularyPayload(write(), "oci://ghcr.io/example/telo")).rejects.toMatchObject({
      code: "manifest_invalid",
      message: expect.stringContaining(message),
    });
  });
});
