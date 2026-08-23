import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { create as createFileSink } from "../src/controllers/logging/file-sink-controller.js";

/**
 * A sink's flush/detach/close is the inverse of its attach.
 *
 * The kernel's own shutdown ALSO flushes and closes every attached sink
 * (`LoggingPipeline.close`), so a clean `kernel.teardown()` cannot tell whether
 * the sink resource carries its own inverse — which is exactly why this is
 * tested at the resource, not through a booted app. What it protects is every
 * unwind that is not a process shutdown: a sink whose own frame unwinds (an
 * import's library torn down, a scope ending) must still flush what it buffered
 * and release its file descriptor.
 */
describe("a log sink's inverse", () => {
  it("flushes, detaches and closes when the resource unwinds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telo-sink-unwind-"));
    const file = join(dir, "sink.jsonl");

    let inverse: (() => unknown) | undefined;
    const detach = vi.fn();
    const ctx = {
      logging: {
        levelFor: () => 0,
        attach: vi.fn(),
        detach,
        recordDrop: vi.fn(),
      },
      // Stands in for the kernel: run the chain, keep the inverse.
      effect: (_reason: string, body: (input: unknown) => any) => ({
        effect: () => {
          throw new Error("unused");
        },
        perform: async () => {
          const outcome = await body(undefined);
          inverse = outcome.inverse;
          return { result: outcome.result, dispose: async () => {} };
        },
      }),
    } as any;

    const instance = (await createFileSink(
      {
        metadata: { name: "sink" },
        destination: file,
        // Big buffer, long interval: nothing but an explicit flush can put a
        // record on disk, so the assertion below is about the inverse alone.
        buffer: 4096,
        flush_interval: "10m",
      },
      ctx,
    )) as unknown as { sink: { write(record: unknown): void } };

    instance.sink.write({
      timestamp: BigInt(Date.now()) * 1_000_000n,
      severityNumber: 9,
      severityText: "info",
      message: "buffered until the resource unwinds",
      attributes: {},
    });
    expect(readFileSync(file, "utf8")).toBe("");

    expect(inverse).toBeTypeOf("function");
    await inverse!();

    expect(readFileSync(file, "utf8")).toContain("buffered until the resource unwinds");
    expect(detach).toHaveBeenCalledOnce();

    rmSync(dir, { recursive: true, force: true });
  });
});
