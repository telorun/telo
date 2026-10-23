import { describe, expect, it } from "vitest";
import { ContentResolution } from "../src/content-resolution.js";
import type { Message } from "../src/types.js";
import { ctx } from "./scripted-agents.js";

// How many references of one call are resolved at once, in what order, and what
// a failure does to the ones not yet started.

const upload = (id: string) => ({ type: "file" as const, mediaType: "text/plain", uri: `upload:${id}` });

/** A resolver whose answers are released by the test, recording what ran when. */
function gatedResolver(fail?: string) {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  let inFlight = 0;
  let peak = 0;
  const config = {
    schemes: ["upload"],
    concurrency: 2n,
    invoke: {
      invoke: async (inputs: { uri: string }) => {
        started.push(inputs.uri);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.set(inputs.uri, resolve));
        inFlight -= 1;
        if (inputs.uri === fail) throw new Error(`cannot read ${fail}`);
        return { body: `contents of ${inputs.uri}` };
      },
    },
    inputs: ({ part }: { part: { uri: string } }) => ({ uri: part.uri }),
    result: ({ result }: { result: { body: string } }) => ({ type: "text", text: result.body }),
  };
  /** Releases every started resolution, one per tick, until `settled` is. */
  const drain = async (settled: Promise<unknown>) => {
    let done = false;
    void settled.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const [uri, resolve] of release) {
        release.delete(uri);
        resolve();
      }
    }
  };
  return { config, started, drain, peak: () => peak };
}

const conversation: Message[] = [
  { role: "user", content: [upload("a"), upload("b")] },
  { role: "assistant", content: "ok" },
  { role: "user", content: [upload("c"), upload("a"), upload("d"), upload("e")] },
];

describe("content resolution", () => {
  it("runs at most `concurrency` resolutions at once, in message order, each uri once", async () => {
    const resolver = gatedResolver();
    const resolution = new ContentResolution(resolver.config, ctx, 'Ai.Text "t"', {}, undefined);
    const sent = resolution.messages(conversation);
    await resolver.drain(sent);

    expect(resolver.peak()).toBe(2);
    expect(resolver.started).toEqual(["upload:a", "upload:b", "upload:c", "upload:d", "upload:e"]);
    expect((await sent).map((message) => message.content)).toEqual([
      [
        { type: "text", text: "contents of upload:a" },
        { type: "text", text: "contents of upload:b" },
      ],
      "ok",
      [
        { type: "text", text: "contents of upload:c" },
        { type: "text", text: "contents of upload:a" },
        { type: "text", text: "contents of upload:d" },
        { type: "text", text: "contents of upload:e" },
      ],
    ]);
  });

  it("starts no queued resolution once one has failed, and fails with it", async () => {
    const resolver = gatedResolver("upload:a");
    const resolution = new ContentResolution(resolver.config, ctx, 'Ai.Text "t"', {}, undefined);
    const sent = resolution.messages(conversation);
    await resolver.drain(sent);

    await expect(sent).rejects.toThrow("cannot read upload:a");
    expect(resolver.started).toEqual(["upload:a", "upload:b"]);
  });
});
