import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

class Capture {
  readonly chunks: string[] = [];
  get records(): Record<string, unknown>[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
}

const SECRET = "h0st-held-admission-secret";

describe("KernelOptions.redactedValues", () => {
  it("redacts a value the host holds from the application's log records", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: HostSecretApp
logging:
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`,
    );
    const stderr = new Capture();
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: stderr.stream, redactedValues: [SECRET] });
    await kernel.load("memory://app");
    await kernel.boot();
    kernel.logging.kernelLogger().info("with the secret", { cookie: SECRET });
    await kernel.teardown();

    expect(stderr.records.find((record) => record["msg"] === "with the secret")?.["attributes"]).toEqual({
      cookie: "[redacted]",
    });
    expect(stderr.chunks.join("")).not.toContain(SECRET);
  });
});
