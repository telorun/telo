import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const SINK_CONTRACT_APP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/sink-contract/telo.yaml",
);

/**
 * The kernel attaches the sinks `logging.sinks` lists, as an effect of each
 * sink's create frame: the undo flushes, detaches and closes it.
 *
 * `kernel.teardown()` ALSO flushes and closes every attached sink
 * (`LoggingPipeline.close`), so it cannot tell whether the attachment carries
 * its own undo — which is why the resources are unwound here without the
 * pipeline's shutdown. What it protects is every unwind that is not a process
 * shutdown: a sink whose frame unwinds must still flush what it buffered and
 * release its file descriptor.
 */
async function boot(manifest: string): Promise<Kernel> {
  const memory = new MemorySource();
  memory.set("app", manifest);
  const kernel = new Kernel({ sources: [memory], env: {} });
  await kernel.load("memory://app");
  await kernel.boot();
  return kernel;
}

describe("a listed sink's attachment", () => {
  it("flushes, detaches and closes when the resource unwinds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telo-sink-unwind-"));
    const file = join(dir, "sink.jsonl");
    // Big buffer, long interval: nothing but an explicit flush can put a record
    // on disk, so the assertion below is about the undo alone.
    const kernel = await boot(`kind: Telo.Application
metadata:
  name: SinkUnwind
logging:
  sinks:
    - !ref sink
---
kind: Telo.FileSink
metadata:
  name: sink
destination: ${file}
buffer: 4096
flush_interval: 10m
`);
    const pipeline = kernel.logging.pipeline;
    expect(pipeline.sinkCount).toBe(1);

    kernel.logging.kernelLogger().info("buffered until the resource unwinds");
    expect(readFileSync(file, "utf8")).toBe("");

    await (kernel as unknown as { rootContext: { teardownResources(): Promise<void> } }).rootContext.teardownResources();

    expect(readFileSync(file, "utf8")).toContain("buffered until the resource unwinds");
    expect(pipeline.sinkCount).toBe(0);

    await kernel.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a listed instance that does not expose the sink contract", async () => {
    // A sink kind whose instance is not the sink itself — the shape a sink
    // written for self-attachment returns.
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(SINK_CONTRACT_APP);
    await expect(kernel.boot()).rejects.toThrow(
      /logging\.sinks\[0\] lists 'hollow', whose instance does not expose the sink contract/,
    );
  });
});
