import { describe, expect, it } from "vitest";
import type { WorkspaceAdapter } from "../model";
import { buildFailureManifest } from "./parse";

function adapterReading(text: string): WorkspaceAdapter {
  return { readFile: async () => text } as unknown as WorkspaceAdapter;
}

async function nameOf(text: string): Promise<string> {
  const manifest = await buildFailureManifest("/ws/fallback/telo.yaml", new Error("bad"), adapterReading(text));
  return manifest.metadata.name;
}

describe("buildFailureManifest name extraction", () => {
  it("reads the name from the metadata block of an unparseable file", async () => {
    expect(await nameOf("kind: Telo.Application\nmetadata:\n  version: 1\n  name: Shop\n  : broken")).toBe("Shop");
  });

  it("falls back to the parent directory when the metadata block holds no name", async () => {
    expect(await nameOf("kind: Telo.Application\nmetadata:\n  version: 1\n")).toBe("fallback");
  });

  it("answers a file of many blank lines after metadata in linear time", async () => {
    const started = Date.now();
    expect(await nameOf(`metadata:\n${"\t\n".repeat(20000)}x`)).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
