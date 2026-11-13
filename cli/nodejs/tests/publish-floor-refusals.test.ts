import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { LoadedGraph } from "@telorun/analyzer";
import { verifyDeclaredRequirements } from "../src/commands/publish.js";
import { createLogger } from "../src/logger.js";
import { Output, installOutput } from "../src/output.js";

let dir: string;
let stderr: string;
let restore: () => void;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-publish-"));
  stderr = "";
  const sink = (capture: boolean) => ({
    isTTY: false,
    write(chunk: string) {
      if (capture) stderr += chunk;
      return true;
    },
  });
  restore = installOutput(new Output({ format: "text", stdout: sink(false), stderr: sink(true), env: {} }));
});

afterEach(() => {
  restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Publish's preflight over a manifest holding `body` after the metadata. */
async function preflight(body: string, published: string[] | null = ['0.119.0', '0.120.0', '0.121.0', '0.122.0']): Promise<{ ok: boolean; error: string }> {
  stderr = "";
  const text = `kind: Telo.Library\nmetadata:\n  name: Geocode\n  version: 1.2.0\n${body}`;
  const file = path.join(dir, "telo.yaml");
  fs.writeFileSync(file, text);
  const graph = { entry: { owner: { manifests: [parse(text)] } } } as unknown as LoadedGraph;
  const ok = await verifyDeclaredRequirements(file, graph, createLogger(false), async () => published, async () => ({ status: "passed" }));
  return { ok, error: stderr.replace(/\x1b\[[0-9;]*m/g, "").trim() };
}

describe("telo publish — floor refusals", () => {
  it("refuses >=unreleased in requires.telo", async () => {
    const { ok, error } = await preflight('requires:\n  telo: ">=unreleased"\n');
    expect(ok).toBe(false);
    expect(error).toContain(
      "telo.yaml holds '>=unreleased' at requires.telo; publish after `telo release apply` has written the line version that carries it.",
    );
  });

  it("refuses >=unreleased in a restrictions entry", async () => {
    const { ok, error } = await preflight(
      'requires:\n  telo: ">=0.80.0"\nrestrictions:\n  - requires: { telo: ">=unreleased" }\n    reason: Needs the next kernel.\n',
    );
    expect(ok).toBe(false);
    expect(error).toContain("holds '>=unreleased' at restrictions[0].requires.telo; publish after `telo release apply`");
  });

  it("refuses an upper bound on requires.telo, naming the restrictions entry that holds a ceiling", async () => {
    const { ok, error } = await preflight('requires:\n  telo: ">=0.119.0 <0.121.0"\n');
    expect(ok).toBe(false);
    expect(error).toContain(
      "telo.yaml: requires.telo '>=0.119.0 <0.121.0' declares an upper bound; requires.telo is a floor only. " +
        "Write the ceiling as a restrictions: entry without versions, which covers this version.",
    );
  });

  it("refuses a restrictions bound naming no published telo, and lets it pass when the registry cannot be asked", async () => {
    const body = 'requires:\n  telo: ">=0.119.0"\nrestrictions:\n  - requires: { telo: "<0.130.0" }\n    reason: Broke there.\n';
    const refused = await preflight(body);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(
      "restrictions[0].requires.telo names 0.130.0, which is not a published telo version.",
    );
    const known = await preflight(body.replace("0.130.0", "0.122.0"));
    expect(known.ok).toBe(true);
    const unreachable = await preflight(body, null);
    expect(unreachable.ok).toBe(true);
  });
});
