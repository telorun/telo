import * as path from "path";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/startup-span/telo.yaml");
const SLOW_APP = path.resolve(here, "__fixtures__/startup-span/slow.yaml");

async function bootAndRead(env: Record<string, string>, processStartedAt?: number, app = APP) {
  const stderr = new PassThrough();
  const chunks: string[] = [];
  stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const startedAt = Date.now();
  const kernel = new Kernel({
    sources: [new LocalFileSource()],
    env,
    stderr,
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
  });
  await kernel.load(app);
  await kernel.boot();
  const elapsedMs = Date.now() - startedAt;
  await kernel.teardown();
  const spans = chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((record) => record.event_name === "telo.span" && record.msg.startsWith("startup "));
  return { spans, elapsedMs };
}

describe("startup span", () => {
  it("is exported once, from the process start the host passes, when a trace sink is attached", async () => {
    const before = Date.now();
    const { spans } = await bootAndRead({ TRACE: "true" }, before - 300);
    expect(spans).toHaveLength(1);
    expect(spans[0].msg).toBe("startup StartupSpanApp");
    expect(spans[0].attributes["telo.span.outcome"]).toBe("ok");
    expect(spans[0].attributes["telo.span.duration_ms"]).toBeGreaterThanOrEqual(300);
  });

  it("starts at the kernel's creation when the host passes no process start", async () => {
    const { spans } = await bootAndRead({ TRACE: "true" });
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["telo.span.duration_ms"]).toBeGreaterThan(0);
  });

  it("lasts at least as long as the slowest resource's init() and no longer than the boot", async () => {
    const { spans, elapsedMs } = await bootAndRead({}, undefined, SLOW_APP);
    expect(spans).toHaveLength(1);
    expect(spans[0].msg).toBe("startup StartupSpanSlow");
    expect(spans[0].attributes["telo.span.outcome"]).toBe("ok");
    expect(spans[0].attributes["telo.span.duration_ms"]).toBeGreaterThanOrEqual(200);
    expect(spans[0].attributes["telo.span.duration_ms"]).toBeLessThanOrEqual(elapsedMs);
  });

  it("is discarded when no trace sink is attached", async () => {
    expect((await bootAndRead({})).spans).toHaveLength(0);
  });
});
