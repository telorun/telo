import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const url = "http://localhost:8080/start?a=1&b=%20";

const app = `kind: Telo.Application
metadata: { name: Opens, version: 1.0.0 }
logging: { level: info }
targets:
  - invoke: !ref opener
    inputs: { url: "${url}" }
---
kind: Telo.OpenUrl
metadata: { name: opener }
`;

/** Runs the app and returns the log records it wrote, one parsed object per line. */
async function run(
  openUrl?: (url: string) => void | Promise<void>,
): Promise<Record<string, any>[]> {
  const lines: string[] = [];
  const stderr = { write: (chunk: string) => (lines.push(String(chunk)), true) } as unknown as NodeJS.WritableStream;
  const silent = { write: () => true } as unknown as NodeJS.WritableStream;
  const memory = new MemorySource();
  memory.set("app", app);
  const kernel = new Kernel({ sources: [memory], stdout: silent, stderr, openUrl });
  await kernel.load("memory://app");
  await kernel.start();
  await kernel.teardown();
  return lines
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

const requested = (records: Record<string, any>[]) =>
  records.filter((r) => r.event_name === "telo.url.open_requested");
const warned = (records: Record<string, any>[]) =>
  records.filter((r) => r.level === "WARN" && r.msg === "The host could not open the URL");

describe("the open-url hook", () => {
  it("receives each URL once, and the call does not wait for it", async () => {
    const seen: string[] = [];
    const records = await run((u) => {
      seen.push(u);
      return new Promise<void>(() => {});
    });
    expect(seen).toEqual([url]);
    expect(requested(records)).toHaveLength(1);
  });

  it("warns, and does not fail the app, when the hook throws or rejects", async () => {
    const thrown = await run(() => {
      throw new Error("no browser");
    });
    const rejected = await run(() => Promise.reject(new Error("no browser")));
    for (const records of [thrown, rejected]) {
      expect(warned(records)).toHaveLength(1);
      expect(requested(records)).toHaveLength(1);
    }
  });

  it("still logs the request with no hook", async () => {
    const records = await run();
    const [record] = requested(records);
    expect(record.attributes["url.full"]).toBe(url);
    expect(warned(records)).toHaveLength(0);
  });
});
