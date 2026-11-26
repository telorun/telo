import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A scoped `Telo.Import` a choice writes — beneath a chosen holder, in a chosen
 * scope array, as a member chosen at a scope-member position — is followed by
 * the load in every option, so the member the running configuration keeps
 * carries the identity the load gave it and its import loads no target itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "__fixtures__/scoped-import-choices/telo.yaml");

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.teardown();
});

async function answers(flag: string): Promise<{ answers: unknown; ownLoads: number }> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: { FLAG_1: flag } });
  kernels.push(kernel);
  // Every library target an import loads that the load did not follow.
  let ownLoads = 0;
  const host = kernel.libraryAnalysisHost.bind(kernel);
  kernel.libraryAnalysisHost = () => {
    const made = host();
    return {
      ...made,
      loadLibrary: (url, registry) => {
        ownLoads++;
        return made.loadLibrary(url, registry);
      },
    };
  };
  // The count is read whatever the boot does, so a load that misses an edge
  // shows as a target loaded here rather than only as the failure it causes.
  try {
    await kernel.load(ENTRY);
    await kernel.boot();
  } catch (error) {
    return { answers: error instanceof Error ? error.message : String(error), ownLoads };
  }
  const read = async (name: string) =>
    (await kernel.invoke<unknown, { answer: unknown }>({ kind: "Telo.Sequence", name }, {})).answer;
  return { answers: [await read("holder"), await read("scope"), await read("member")], ownLoads };
}

describe("a scoped import a choice writes", () => {
  it("reaches the library of the option the configuration takes, loading no target of its own", async () => {
    expect(await answers("true")).toEqual({ answers: [42, 42, 42], ownLoads: 0 });
    expect(await answers("false")).toEqual({ answers: [7, 7, 7], ownLoads: 0 });
  }, 60_000);
});
