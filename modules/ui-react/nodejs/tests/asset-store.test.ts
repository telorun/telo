import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetStore } from "../src/asset-store.js";

describe("the addresses of browser files", () => {
  it("give a file two entries share one address", () => {
    const store = new AssetStore();
    const js = "text/javascript";
    store.add({ digest: "bbb", name: "react.js", mediaType: js, file: "/build/react.js", body: Buffer.from("") });
    store.add({ digest: "bbb", name: "chunks/shared.js", mediaType: js, file: "/build/chunks/shared.js", body: Buffer.from("") });
    store.add({ digest: "aaa", name: "react-dom.js", mediaType: js, file: "/build/react-dom.js", body: Buffer.from("") });
    store.add({ digest: "aaa", name: "chunks/shared.js", mediaType: js, file: "/build/chunks/shared.js", body: Buffer.from("") });
    store.addBytes("theme.css", "text/css", Buffer.from("a{}"));
    const remaps = store.sharedFileRemaps((ref) => `/assets/${ref.digest}/${ref.name}`);
    // Whichever entry imports the chunk, the page loads the one copy.
    expect(remaps).toEqual({ "/assets/bbb/chunks/shared.js": "/assets/aaa/chunks/shared.js" });
  });

  it("serve the bytes read when a file was added, whatever happens to the file after", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ui-react-assets-"));
    const file = join(directory, "entry.js");
    writeFileSync(file, "export const built = 1;");
    const store = new AssetStore();
    const ref = await store.hold({ digest: "aaa", name: "entry.js", mediaType: "text/javascript", file });
    writeFileSync(file, "export const built = 2;");
    rmSync(directory, { recursive: true });
    expect(store.get(ref.digest, ref.name)?.body.toString()).toBe("export const built = 1;");
  });
});
