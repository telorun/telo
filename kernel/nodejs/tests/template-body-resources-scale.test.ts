import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A family of N members boots, starts and publishes every member's reading in
 * time linear in N: one member's publication costs one write whatever the
 * family's size.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = path.resolve(here, "../../../tests/__fixtures__/check-run-agreement/scope-members/kinds");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const app = (members: number) => `kind: Telo.Application
metadata: { name: FamilyScale }
imports:
  Kinds: ${KINDS}
targets:
  - !ref pool
---
kind: Telo.Definition
metadata: { name: Pool }
capability: Telo.Service
schema:
  type: object
  properties:
    jobs:
      type: object
      additionalProperties: { type: object }
resources:
  - !for-each
    metadata: { name: counters }
    in: !cel "self.jobs"
    emit:
      kind: Kinds.Counter
targets:
  - !for-each
    in: !cel "self.jobs"
    emit: !ref counters[each.key]
---
kind: Self.Pool
metadata: { name: pool }
jobs:
${Array.from({ length: members }, (_, i) => `  k${i}: {}`).join("\n")}
`;

async function bootMillis(members: number): Promise<number> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-family-scale-")));
  dirs.push(dir);
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, app(members));
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout: { write: () => true } as never });
  const start = performance.now();
  try {
    await kernel.load(appPath);
    await kernel.boot();
    await kernel.runTargets();
  } finally {
    await kernel.teardown();
  }
  return performance.now() - start;
}

describe("a family's readings at scale", () => {
  it("boots and publishes 1,000 members in time linear against 10 and 100", async () => {
    await bootMillis(10);
    const small = await bootMillis(10);
    const medium = await bootMillis(100);
    const large = await bootMillis(1000);
    // Generous: linear is ~10x for 10x the members, quadratic ~100x.
    expect(large / medium).toBeLessThan(40);
    expect(medium / Math.max(small, 1)).toBeLessThan(80);
  }, 280_000);
});
