import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { heldStreamOf } from "../src/held-streams.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "__fixtures__/held-streams");
const WALKS = Symbol.for("telo.test.heldStreamBodyWalks");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function boot(): Promise<{ kernel: Kernel; teardowns: () => number; liveScopes: () => number }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-held-streams-")));
  dirs.push(dir);
  await fs.cp(FIXTURES, path.join(dir, "fix"), { recursive: true });
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(
    appPath,
    `kind: Telo.Application
metadata: { name: HeldStreamOwnership, version: 1.0.0 }
imports: { Fix: ./fix }
targets:
  - { name: boot, invoke: !ref usageReply }
---
kind: Telo.Sequence
metadata: { name: usageReply }
with:
  - { kind: Fix.Source, metadata: { name: model } }
steps:
  - { name: call, invoke: !ref model }
outputs: { output: !cel "steps.call.result.output", usage: !cel "steps.call.result.usage" }
---
kind: Fix.Source
metadata: { name: plainSource }
---
kind: Telo.Sequence
metadata: { name: hopA }
steps:
  - { name: call, invoke: !ref plainSource }
outputs: { output: !cel "steps.call.result.output" }
---
kind: Telo.Sequence
metadata: { name: hopB }
steps:
  - { name: call, invoke: !ref hopA }
outputs: { output: !cel "steps.call.result.output" }
---
kind: Telo.Sequence
metadata: { name: hopC }
steps:
  - { name: call, invoke: !ref hopB }
outputs: { output: !cel "steps.call.result.output" }
---
kind: Fix.Body
metadata: { name: big }
`,
  );
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  let teardowns = 0;
  kernel.on("Fix.Source.model.Teardown", () => {
    teardowns++;
  });
  await kernel.load(appPath);
  await kernel.boot();
  const root = (kernel as unknown as { rootContext: { children: unknown[] } }).rootContext;
  return { kernel, teardowns: () => teardowns, liveScopes: () => root.children.length };
}

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("a held stream's owner", () => {
  it("is the boot run for a target's result, closed when the last target returns", async () => {
    const { kernel, teardowns } = await boot();
    try {
      await kernel.runTargets();
      await settle(() => teardowns() === 1);
      expect(teardowns()).toBe(1);
    } finally {
      await kernel.teardown();
    }
  });

  it("is nobody under the bare root: the stream is cancelled at once and the scope released", async () => {
    const { kernel, teardowns, liveScopes } = await boot();
    try {
      const baseline = liveScopes();
      let last: { output: AsyncIterable<unknown>; usage: { items: number } } | undefined;
      for (let i = 0; i < 20; i++) last = await kernel.invoke("Telo.Sequence.usageReply", {});
      await settle(() => teardowns() === 20);
      expect(teardowns()).toBe(20);
      expect(liveScopes()).toBe(baseline);
      expect(last!.usage.items).toBe(2);
      const pull = async () => {
        for await (const item of last!.output) void item;
      };
      await expect(pull()).rejects.toMatchObject({
        code: "ERR_INVOKE_CANCELLED",
        message: expect.stringContaining("reached a caller that opened no context"),
      });
    } finally {
      await kernel.teardown();
    }
  });
});

describe("a dispatch with no held stream in play", () => {
  it("hands an unscoped stream through three dispatches as the identical object", async () => {
    const { kernel } = await boot();
    try {
      const { output } = await kernel.invoke<object, { output: { producedBySource?: boolean } }>(
        "Telo.Sequence.hopC",
        {},
      );
      expect(output.producedBySource).toBe(true);
      expect(heldStreamOf(output)).toBeUndefined();
    } finally {
      await kernel.teardown();
    }
  });

  it("does not walk a large result no contract types", async () => {
    const { kernel } = await boot();
    try {
      const before = (globalThis as Record<symbol, number | undefined>)[WALKS] ?? 0;
      await kernel.invoke("Fix.Body.big", {});
      expect((globalThis as Record<symbol, number | undefined>)[WALKS] ?? 0).toBe(before);
    } finally {
      await kernel.teardown();
    }
  });
});
