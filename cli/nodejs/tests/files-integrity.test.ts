import { describe, expect, it } from "vitest";
import { computeFilesIntegrity } from "@telorun/kernel";

describe("computeFilesIntegrity", () => {
  it("is stable regardless of input order", async () => {
    const a = await computeFilesIntegrity([
      { name: "public/app.js", content: Buffer.from("alert(1)") },
      { name: "public/index.html", content: Buffer.from("<html>") },
    ]);
    const b = await computeFilesIntegrity([
      { name: "public/index.html", content: Buffer.from("<html>") },
      { name: "public/app.js", content: Buffer.from("alert(1)") },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[A-Za-z0-9_-]+$/);
  });

  it("excludes telo.yaml so the manifest can carry the digest without self-reference", async () => {
    const withoutManifest = await computeFilesIntegrity([
      { name: "public/app.js", content: Buffer.from("alert(1)") },
    ]);
    const withManifest = await computeFilesIntegrity([
      { name: "telo.yaml", content: Buffer.from("kind: Telo.Library\nfilesIntegrity: sha256-anything") },
      { name: "public/app.js", content: Buffer.from("alert(1)") },
    ]);
    expect(withManifest).toBe(withoutManifest);
  });

  it("changes when a payload file's content changes", async () => {
    const original = await computeFilesIntegrity([{ name: "a.txt", content: Buffer.from("one") }]);
    const tampered = await computeFilesIntegrity([{ name: "a.txt", content: Buffer.from("two") }]);
    expect(tampered).not.toBe(original);
  });
});
