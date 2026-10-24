import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deliverSupervisor } from "./supervisor-delivery.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deliverSupervisor", () => {
  it("writes the binary, executable, into a directory named by its digest, and reuses it", async () => {
    dir = mkdtempSync(join(tmpdir(), "supervisor-delivery-"));
    const binary = join(dir, "supervisor-in-image");
    writeFileSync(binary, "binary of build A");
    const root = join(dir, "bundles");

    const delivered = await deliverSupervisor(binary, root);

    expect(delivered.build).toMatch(/^[0-9a-f]{16}$/);
    expect(delivered.subpath).toBe(`.supervisor/${delivered.build}`);
    const written = join(root, delivered.subpath, "supervisor");
    expect(readFileSync(written, "utf8")).toBe("binary of build A");
    // Windows keeps no executable bits.
    if (process.platform !== "win32") expect(statSync(written).mode & 0o777).toBe(0o755);
    expect(await deliverSupervisor(binary, root)).toEqual(delivered);

    writeFileSync(binary, "binary of build B");
    expect((await deliverSupervisor(binary, root)).build).not.toBe(delivered.build);
  });

  it("names the path when the image carries no supervisor", async () => {
    dir = mkdtempSync(join(tmpdir(), "supervisor-delivery-"));
    await expect(deliverSupervisor(join(dir, "missing"), dir)).rejects.toThrow(
      `the session supervisor is not readable at ${join(dir, "missing")}`,
    );
  });
});
